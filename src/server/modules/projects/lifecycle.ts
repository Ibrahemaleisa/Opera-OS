import { z } from "zod";
import { Prisma, type Project, type ProjectStatus } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { can, isArchivedStatus, projectScope, type ProjectScope } from "@/server/authz/policy";
import { casUpdate } from "@/server/concurrency";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { emit } from "@/server/modules/automation/outbox";
import { cancelPendingApprovalsTx, supersedeApprovalsTx } from "@/server/modules/approvals/service";
import { notify, type NotifyInput } from "@/server/modules/notifications/notify";
import { withCancelled, type StatusDef } from "@/server/modules/templates/definition";

/**
 * Project lifecycle (BUSINESS_RULES §1): the transition table, the activation / completion / close
 * gates, the cancel cascade and the read-only impact preview. The preview and the execution use the
 * same selectors (`selectors()`), so what the dialog shows is what the cascade changes (LC-14).
 */

export const LIFECYCLE_TARGETS = ["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED", "CLOSED", "CANCELLED"] as const;
export type LifecycleTarget = (typeof LIFECYCLE_TARGETS)[number];

type Who = "pm" | "director";
type ReasonRule = "required" | "none" | "override";
interface Rule {
  who: Who;
  reason: ReasonRule;
}

/** §1.2. "director" = `project.delete` (directors and owners); "pm" = project manage scope. */
const TRANSITIONS: Record<string, Partial<Record<LifecycleTarget, Rule>>> = {
  DRAFT: { PLANNING: { who: "pm", reason: "none" }, CANCELLED: { who: "pm", reason: "required" } },
  PLANNING: { ACTIVE: { who: "pm", reason: "none" }, ON_HOLD: { who: "pm", reason: "required" }, CANCELLED: { who: "director", reason: "required" } },
  ACTIVE: { PLANNING: { who: "pm", reason: "required" }, ON_HOLD: { who: "pm", reason: "required" }, COMPLETED: { who: "pm", reason: "none" }, CANCELLED: { who: "director", reason: "required" } },
  // ON_HOLD → previous only (PLANNING or ACTIVE, from the hold's audit row): checked in `ruleFor`
  ON_HOLD: { PLANNING: { who: "pm", reason: "none" }, ACTIVE: { who: "pm", reason: "none" }, CANCELLED: { who: "director", reason: "required" } },
  COMPLETED: { ACTIVE: { who: "pm", reason: "required" }, CLOSED: { who: "director", reason: "override" }, CANCELLED: { who: "director", reason: "required" } },
  CLOSED: { COMPLETED: { who: "director", reason: "required" } },
  CANCELLED: { PLANNING: { who: "director", reason: "required" } },
};

/** AT_RISK is legacy (LC rule 1): any code still reading it treats it as ACTIVE. */
export const effectiveStatus = (s: string) => (s === "AT_RISK" ? "ACTIVE" : s);

const OPEN_TASK = ["TODO", "ACTIVE", "BLOCKED", "REVIEW"] as const;
const CASCADE_APPROVAL_TYPES = ["TASK", "DELIVERABLE", "MILESTONE", "DESIGN_REVISION", "CAMPAIGN", "PURCHASE_ORDER"];
const TAIL_APPROVAL_TYPES = ["EXPENSE", "CHANGE_ORDER"];
const FINANCIAL_APPROVAL_TYPES = ["PURCHASE_ORDER", "EXPENSE", "CHANGE_ORDER"];
const CANCELLABLE_CAMPAIGN = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "SENDING"] as const;
const CANCELLABLE_DELIVERY = ["PENDING", "VALIDATING", "READY", "ASSIGNED", "RESCHEDULED", "FAILED_ATTEMPT"] as const;
const OPEN_INCIDENT = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] as const;
const OPEN_CHANGE_REQUEST = ["OPEN", "UNDER_REVIEW"];

export const reasonSchema = z.string().trim().min(10).max(1000);

export const statusChangeInput = z.object({
  id: z.string(),
  status: z.enum(LIFECYCLE_TARGETS),
  version: z.number().int().optional(),
  reason: z.string().trim().max(1000).optional().nullable(),
  /** cancel only: tell the project's client contacts (default on, §1.4b) */
  notifyClient: z.boolean().optional(),
  /** hold only: the expected resume date, kept in the audit row */
  resumeOn: z.coerce.date().optional().nullable(),
});
export type StatusChangeInput = z.output<typeof statusChangeInput>;

/** The shared selectors behind both the preview and the cascade (LC-14). */
function selectors(projectId: string, now: Date) {
  return {
    openTasks: { projectId, statusCategory: { in: [...OPEN_TASK] } } satisfies Prisma.TaskWhereInput,
    openTopTasks: { projectId, parentId: null, statusCategory: { in: [...OPEN_TASK] } } satisfies Prisma.TaskWhereInput,
    cascadeApprovals: { projectId, status: "PENDING", entityType: { in: CASCADE_APPROVAL_TYPES } } satisfies Prisma.ApprovalWhereInput,
    tailApprovals: { projectId, status: "PENDING", entityType: { in: TAIL_APPROVAL_TYPES } } satisfies Prisma.ApprovalWhereInput,
    pendingApprovals: { projectId, status: "PENDING" } satisfies Prisma.ApprovalWhereInput,
    nonFinancialApprovals: { projectId, status: "PENDING", entityType: { notIn: FINANCIAL_APPROVAL_TYPES } } satisfies Prisma.ApprovalWhereInput,
    cancellableCampaigns: { projectId, status: { in: [...CANCELLABLE_CAMPAIGN] } } satisfies Prisma.InvitationCampaignWhereInput,
    liveSends: { projectId, status: { in: ["SCHEDULED", "SENDING"] } } satisfies Prisma.InvitationCampaignWhereInput,
    sentCampaigns: { projectId, status: { in: ["ACTIVE", "COMPLETED"] } } satisfies Prisma.InvitationCampaignWhereInput,
    cancellableDeliveries: { projectId, status: { in: [...CANCELLABLE_DELIVERY] } } satisfies Prisma.DeliveryWhereInput,
    inCarDeliveries: { projectId, status: "OUT_FOR_DELIVERY" } satisfies Prisma.DeliveryWhereInput,
    openDeliveries: { projectId, status: { notIn: ["DELIVERED", "RETURNED", "CANCELLED"] } } satisfies Prisma.DeliveryWhereInput,
    cancellablePOs: { projectId, status: { in: ["DRAFT", "PENDING_APPROVAL"] } } satisfies Prisma.PurchaseOrderWhereInput,
    listedPOs: { projectId, status: { in: ["APPROVED", "ISSUED", "PARTIALLY_RECEIVED"] } } satisfies Prisma.PurchaseOrderWhereInput,
    openPOs: { projectId, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ISSUED", "PARTIALLY_RECEIVED"] } } satisfies Prisma.PurchaseOrderWhereInput,
    submittedExpenses: { projectId, status: "SUBMITTED" } satisfies Prisma.ExpenseWhereInput,
    issuedWOs: { projectId, status: "ISSUED" } satisfies Prisma.WorkOrderWhereInput,
    runningWOs: { projectId, status: { in: ["ACCEPTED", "IN_PROGRESS"] } } satisfies Prisma.WorkOrderWhereInput,
    deliveredWOs: { projectId, status: "DELIVERED" } satisfies Prisma.WorkOrderWhereInput,
    openWOs: { projectId, status: { in: ["ISSUED", "ACCEPTED", "IN_PROGRESS", "DELIVERED"] } } satisfies Prisma.WorkOrderWhereInput,
    closableEvents: { projectId, phase: { notIn: ["LIVE", "CLOSED"] } } satisfies Prisma.EventWhereInput,
    liveEvents: { projectId, phase: "LIVE" } satisfies Prisma.EventWhereInput,
    futureShifts: (eventIds: string[]) => ({ eventId: { in: eventIds }, status: "SCHEDULED", startsAt: { gt: now } }) satisfies Prisma.ShiftWhereInput,
    cancellableGuests: { projectId, attendance: { in: ["EXPECTED", "CONFIRMED"] } } satisfies Prisma.GuestWhereInput,
    openIncidents: { projectId, status: { in: [...OPEN_INCIDENT] } } satisfies Prisma.IncidentWhereInput,
    openChangeRequests: { projectId, status: { in: OPEN_CHANGE_REQUEST } } satisfies Prisma.ChangeRequestWhereInput,
    unsignedDeliverables: { projectId, clientVisible: true, requiresApproval: true, status: { not: "APPROVED" } } satisfies Prisma.DeliverableWhereInput,
  };
}

// ── Preview types ──────────────────────────────────────────────────────────

export interface ImpactItem {
  id: string;
  label: string;
  status: string;
  owner?: string | null;
  amount?: number | null;
  link?: string;
}

/** One row of §1.3 / §1.4: what happens to a kind of item. */
export interface ImpactRow {
  key: string;
  mode: "auto" | "listed" | "unchanged";
  count: number;
  items: ImpactItem[];
  /** counts are shown but item detail needs finance scope (UX "partial permission") */
  restricted?: boolean;
}

export interface GateRow {
  gate: string;
  key: string;
  count: number;
  ok: boolean;
  overridable: boolean;
  /** the permission an override of this gate needs beyond `project.delete` */
  needs?: "finance.approve";
}

export interface StatusImpact {
  projectId: string;
  code: string;
  from: string;
  to: LifecycleTarget;
  version: number;
  allowed: boolean;
  /** why the caller can't make this move (permission), when not allowed */
  deniedReason?: "forbidden" | "invalidTransition";
  reasonRequired: boolean;
  rows: ImpactRow[];
  gates: GateRow[];
  /** gates that block the move with no override (C1, LIVE event, G3/G4 in-flight) */
  blocking: GateRow[];
  override: { needed: boolean; allowed: boolean; missing: string[] };
  clientRecipients: { id: string; name: string }[];
  resumeTo: "PLANNING" | "ACTIVE" | null;
}

// ── Rules ──────────────────────────────────────────────────────────────────

/** The status a held project returns to: the `before` of the audit row that put it on hold. */
export async function resumeTarget(tx: Tx, projectId: string): Promise<"PLANNING" | "ACTIVE"> {
  const hold = await tx.auditEvent.findFirst({ where: { entityType: "PROJECT", entityId: projectId, action: "project.status", after: { path: ["status"], equals: "ON_HOLD" } }, orderBy: { createdAt: "desc" }, select: { before: true } });
  const before = effectiveStatus(String((hold?.before as { status?: string } | null)?.status ?? "ACTIVE"));
  return before === "PLANNING" ? "PLANNING" : "ACTIVE";
}

function ruleFor(from: string, to: LifecycleTarget, resumeTo: string | null): Rule | null {
  const f = effectiveStatus(from);
  const rule = TRANSITIONS[f]?.[to] ?? null;
  if (rule && f === "ON_HOLD" && to !== "CANCELLED" && to !== resumeTo) return null;
  return rule;
}

function mayMove(ctx: ServiceContext, scope: ProjectScope, rule: Rule) {
  if (scope.clientView || scope.fieldOnly) return false;
  // directors' moves need project.delete; a PM move needs manage scope, which project.delete holders also have
  if (rule.who === "director") return can(ctx, "project.delete");
  return scope.manage || can(ctx, "project.delete");
}

/** The targets offered in the status menu, with whether each opens the impact dialog. */
export function availableTargets(ctx: ServiceContext, scope: ProjectScope, resumeTo: string | null) {
  const from = effectiveStatus(scope.project.status);
  return LIFECYCLE_TARGETS.flatMap((to) => {
    const rule = ruleFor(from, to, resumeTo);
    if (!rule || !mayMove(ctx, scope, rule)) return [];
    const preview = to === "CANCELLED" || to === "CLOSED" || to === "ON_HOLD" || to === "COMPLETED" || isArchivedStatus(from) || rule.reason === "required";
    return [{ to, reason: rule.reason, preview }];
  });
}

async function activePMs(tx: Tx, projectId: string) {
  const pms = await tx.projectMember.findMany({ where: { projectId, role: "MANAGER" }, select: { userId: true } });
  if (!pms.length) return [];
  const active = await tx.membership.findMany({ where: { userId: { in: pms.map((p) => p.userId) }, status: "ACTIVE" }, select: { userId: true } });
  return active.map((a) => a.userId);
}

async function eventIdsOf(tx: Tx, projectId: string) {
  return (await tx.event.findMany({ where: { projectId }, select: { id: true } })).map((e) => e.id);
}

/** Gates for a move (§1.2 A1 / C1, §1.4 G1–G10, the LIVE-event block on cancel). */
async function gatesFor(tx: Tx, project: Project, to: LifecycleTarget, now: Date): Promise<GateRow[]> {
  const sel = selectors(project.id, now);
  const from = effectiveStatus(project.status);
  if (to === "ACTIVE" && from === "PLANNING") {
    const [pms] = [await activePMs(tx, project.id)];
    const anchored = !!(project.eventStartAt ?? project.deadline);
    return [
      { gate: "A1", key: "anchorDate", count: anchored ? 0 : 1, ok: anchored, overridable: false },
      { gate: "A1", key: "activePm", count: pms.length ? 0 : 1, ok: pms.length > 0, overridable: false },
    ];
  }
  if (to === "COMPLETED" && from === "ACTIVE") {
    const [live, sends, inCar] = await Promise.all([tx.event.count({ where: sel.liveEvents }), tx.invitationCampaign.count({ where: sel.liveSends }), tx.delivery.count({ where: sel.inCarDeliveries })]);
    return [
      { gate: "C1", key: "liveEvents", count: live, ok: !live, overridable: false },
      { gate: "C1", key: "liveSends", count: sends, ok: !sends, overridable: false },
      { gate: "C1", key: "inCarDeliveries", count: inCar, ok: !inCar, overridable: false },
    ];
  }
  if (to === "CANCELLED") {
    const live = await tx.event.count({ where: sel.liveEvents });
    return [{ gate: "LIVE", key: "liveEvents", count: live, ok: !live, overridable: false }];
  }
  if (to === "CLOSED") {
    const [tasks, approvals, deliveries, inCar, campaigns, liveSends, pos, expenses, wos, incidents, crs, unsigned] = await Promise.all([
      tx.task.count({ where: sel.openTopTasks }),
      tx.approval.count({ where: sel.pendingApprovals }),
      tx.delivery.count({ where: sel.openDeliveries }),
      tx.delivery.count({ where: sel.inCarDeliveries }),
      tx.invitationCampaign.count({ where: sel.cancellableCampaigns }),
      tx.invitationCampaign.count({ where: sel.liveSends }),
      tx.purchaseOrder.count({ where: sel.openPOs }),
      tx.expense.count({ where: sel.submittedExpenses }),
      tx.workOrder.count({ where: sel.openWOs }),
      tx.incident.count({ where: sel.openIncidents }),
      tx.changeRequest.count({ where: sel.openChangeRequests }),
      tx.deliverable.count({ where: sel.unsignedDeliverables }),
    ]);
    return [
      { gate: "G1", key: "openTasks", count: tasks, ok: !tasks, overridable: true },
      { gate: "G2", key: "pendingApprovals", count: approvals, ok: !approvals, overridable: true },
      { gate: "G3", key: "openDeliveries", count: deliveries, ok: !deliveries, overridable: !inCar },
      { gate: "G4", key: "openCampaigns", count: campaigns, ok: !campaigns, overridable: !liveSends },
      { gate: "G5", key: "openPOs", count: pos, ok: !pos, overridable: true, needs: "finance.approve" },
      { gate: "G6", key: "submittedExpenses", count: expenses, ok: !expenses, overridable: true, needs: "finance.approve" },
      { gate: "G7", key: "openWorkOrders", count: wos, ok: !wos, overridable: true, needs: "finance.approve" },
      { gate: "G8", key: "openIncidents", count: incidents, ok: !incidents, overridable: true },
      { gate: "G9", key: "openChangeRequests", count: crs, ok: !crs, overridable: true },
      { gate: "G10", key: "clientSignOff", count: unsigned, ok: !unsigned, overridable: true },
    ];
  }
  return [];
}

const gateList = (gates: GateRow[]) => gates.map((g) => `${g.gate}:${g.count}`);

function overrideState(ctx: ServiceContext, gates: GateRow[]) {
  const open = gates.filter((g) => !g.ok);
  const missing = [...new Set(open.filter((g) => g.needs && !can(ctx, g.needs)).map((g) => g.needs!))];
  return { needed: open.length > 0, allowed: open.length > 0 && open.every((g) => g.overridable) && can(ctx, "project.delete") && !missing.length, missing };
}

// ── Preview ────────────────────────────────────────────────────────────────

const nameOf = (u: { name: string; nameAr: string | null } | null | undefined, locale: string) => (u ? (locale === "ar" ? u.nameAr : null) ?? u.name : null);

/**
 * Read-only impact of a status change (LC rule 4, `projectStatusImpact`): the §1.3 / §1.4 rows that
 * apply with counts and items, auto vs listed, the gates, and the client contacts who'd be told.
 */
export async function previewProjectStatusChange(ctx: ServiceContext, projectId: string, to: LifecycleTarget): Promise<StatusImpact> {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
    return impactTx(tx, ctx, scope, to, new Date());
  });
}

async function impactTx(tx: Tx, ctx: ServiceContext, scope: ProjectScope, to: LifecycleTarget, now: Date): Promise<StatusImpact> {
  const project = scope.project;
  const from = effectiveStatus(project.status);
  const resumeTo = from === "ON_HOLD" ? await resumeTarget(tx, project.id) : null;
  const rule = ruleFor(from, to, resumeTo);
  const allowed = !!rule && mayMove(ctx, scope, rule);
  const gates = rule ? await gatesFor(tx, project, to, now) : [];
  const nonOverridable = gates.filter((g) => !g.ok && !g.overridable);
  const rows: ImpactRow[] = [];
  const sel = selectors(project.id, now);
  const locale = ctx.locale;
  const money = scope.finance;
  const link = (path: string) => `/projects/${project.id}${path}`;

  if (to === "CANCELLED" && rule) {
    const eventIds = await eventIdsOf(tx, project.id);
    const [tasks, approvals, kept, campaigns, sent, deliveries, inCar, pos, listedPOs, issuedWOs, runningWOs, deliveredWOs, shifts, events, guests, crs, incidents] = await Promise.all([
      tx.task.findMany({ where: sel.openTasks, select: { id: true, number: true, title: true, status: true, owner: { select: { name: true, nameAr: true } } }, orderBy: { number: "asc" } }),
      tx.approval.findMany({ where: sel.cascadeApprovals, select: { id: true, title: true, status: true, entityType: true } }),
      tx.approval.findMany({ where: sel.tailApprovals, select: { id: true, title: true, status: true, entityType: true } }),
      tx.invitationCampaign.findMany({ where: sel.cancellableCampaigns, select: { id: true, name: true, status: true, type: true } }),
      tx.invitationCampaign.findMany({ where: { projectId: project.id, status: "SENDING" }, select: { id: true } }),
      tx.delivery.count({ where: sel.cancellableDeliveries }),
      tx.delivery.findMany({ where: sel.inCarDeliveries, select: { id: true, trackingCode: true, status: true, agent: { select: { name: true, nameAr: true } } } }),
      tx.purchaseOrder.findMany({ where: sel.cancellablePOs, select: { id: true, code: true, title: true, status: true, amount: true, vatAmount: true } }),
      tx.purchaseOrder.findMany({ where: sel.listedPOs, select: { id: true, code: true, title: true, status: true, amount: true, vatAmount: true } }),
      tx.workOrder.findMany({ where: sel.issuedWOs, select: { id: true, title: true, status: true } }),
      tx.workOrder.findMany({ where: sel.runningWOs, select: { id: true, title: true, status: true } }),
      tx.workOrder.findMany({ where: sel.deliveredWOs, select: { id: true, title: true, status: true } }),
      tx.shift.findMany({ where: sel.futureShifts(eventIds), select: { id: true, role: true, status: true, startsAt: true, userId: true } }),
      tx.event.findMany({ where: sel.closableEvents, select: { id: true, name: true, phase: true } }),
      tx.guest.count({ where: sel.cancellableGuests }),
      tx.changeRequest.findMany({ where: sel.openChangeRequests, select: { id: true, title: true, status: true } }),
      tx.incident.count({ where: sel.openIncidents }),
    ]);
    const [queued, sentMessages] = await Promise.all([
      campaigns.length ? tx.messageJob.count({ where: { status: "QUEUED", invitation: { campaignId: { in: campaigns.map((c) => c.id) } } } }) : 0,
      sent.length ? tx.messageJob.count({ where: { status: { in: ["SENT", "DELIVERED", "READ"] }, invitation: { campaignId: { in: sent.map((c) => c.id) } } } }) : 0,
    ]);
    const amount = (p: { amount: unknown; vatAmount: unknown }) => (money ? Number(p.amount) + Number(p.vatAmount) : null);
    rows.push(
      { key: "tasks", mode: "auto", count: tasks.length, items: tasks.slice(0, 50).map((t) => ({ id: t.id, label: `#${t.number} ${t.title}`, status: t.status, owner: nameOf(t.owner, locale), link: `/tasks/${t.id}` })) },
      { key: "approvals", mode: "auto", count: approvals.length, items: approvals.filter((a) => money || !FINANCIAL_APPROVAL_TYPES.includes(a.entityType)).slice(0, 50).map((a) => ({ id: a.id, label: a.title, status: a.status, link: link("/approvals") })) },
      { key: "campaigns", mode: "auto", count: campaigns.length, items: campaigns.map((c) => ({ id: c.id, label: c.name, status: c.status })) },
      { key: "queuedMessages", mode: "auto", count: queued, items: [] },
      { key: "deliveries", mode: "auto", count: deliveries, items: [] },
      { key: "purchaseOrders", mode: "auto", count: pos.length, items: money ? pos.map((p) => ({ id: p.id, label: `${p.code} ${p.title}`, status: p.status, amount: amount(p) })) : [], restricted: !money },
      { key: "workOrders", mode: "auto", count: issuedWOs.length, items: issuedWOs.map((w) => ({ id: w.id, label: w.title, status: w.status })) },
      { key: "shifts", mode: "auto", count: shifts.length, items: shifts.slice(0, 50).map((s) => ({ id: s.id, label: s.role, status: s.status })) },
      { key: "events", mode: "auto", count: events.length, items: events.map((e) => ({ id: e.id, label: e.name, status: e.phase })) },
      { key: "guests", mode: "auto", count: guests, items: [] },
      { key: "changeRequests", mode: "auto", count: crs.length, items: crs.map((c) => ({ id: c.id, label: c.title, status: c.status })) },
      { key: "inCarDeliveries", mode: "listed", count: inCar.length, items: inCar.map((d) => ({ id: d.id, label: d.trackingCode, status: d.status, owner: nameOf(d.agent, locale) })) },
      { key: "vendorCancellation", mode: "listed", count: listedPOs.length, items: money ? listedPOs.map((p) => ({ id: p.id, label: `${p.code} ${p.title}`, status: p.status, amount: amount(p) })) : [], restricted: !money },
      { key: "runningWorkOrders", mode: "listed", count: runningWOs.length + deliveredWOs.length, items: [...runningWOs, ...deliveredWOs].map((w) => ({ id: w.id, label: w.title, status: w.status })) },
      { key: "keptApprovals", mode: "unchanged", count: kept.length, items: money ? kept.map((a) => ({ id: a.id, label: a.title, status: a.status })) : [], restricted: !money },
      { key: "sentMessages", mode: "unchanged", count: sentMessages, items: [] },
      { key: "incidents", mode: "unchanged", count: incidents, items: [] },
    );
  }

  if (to === "CLOSED" && rule) {
    // override effects, per gate: what an override changes (auto) and what stays open (listed)
    const [tasks, nonFin, crs] = await Promise.all([
      tx.task.findMany({ where: sel.openTasks, select: { id: true, number: true, title: true, status: true, owner: { select: { name: true, nameAr: true } } }, orderBy: { number: "asc" } }),
      tx.approval.count({ where: sel.nonFinancialApprovals }),
      tx.changeRequest.count({ where: sel.openChangeRequests }),
    ]);
    const [deliveries, campaigns, pos] = await Promise.all([tx.delivery.count({ where: sel.cancellableDeliveries }), tx.invitationCampaign.count({ where: { ...sel.cancellableCampaigns, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } } }), tx.purchaseOrder.findMany({ where: sel.openPOs, select: { id: true, code: true, title: true, status: true, amount: true, vatAmount: true } })]);
    rows.push(
      { key: "tasks", mode: "auto", count: tasks.length, items: tasks.slice(0, 50).map((t) => ({ id: t.id, label: `#${t.number} ${t.title}`, status: t.status, owner: nameOf(t.owner, locale), link: `/tasks/${t.id}` })) },
      { key: "approvals", mode: "auto", count: nonFin, items: [] },
      { key: "deliveries", mode: "auto", count: deliveries, items: [] },
      { key: "campaigns", mode: "auto", count: campaigns, items: [] },
      { key: "changeRequests", mode: "auto", count: crs, items: [] },
      { key: "openCommitments", mode: "listed", count: pos.length, items: money ? pos.map((p) => ({ id: p.id, label: `${p.code} ${p.title}`, status: p.status, amount: Number(p.amount) + Number(p.vatAmount) })) : [], restricted: !money },
    );
  }

  if (to === "ON_HOLD" && rule) {
    const [sends, tasks] = await Promise.all([tx.invitationCampaign.findMany({ where: { projectId: project.id, status: "SCHEDULED" }, select: { id: true, name: true, status: true } }), tx.task.count({ where: sel.openTasks })]);
    rows.push({ key: "heldSends", mode: "listed", count: sends.length, items: sends.map((c) => ({ id: c.id, label: c.name, status: c.status })) }, { key: "pausedReminders", mode: "unchanged", count: tasks, items: [] });
  }

  if (from === "ON_HOLD" && resumeTo === to) {
    const passed = await tx.invitationCampaign.findMany({ where: { projectId: project.id, status: "SCHEDULED", scheduledAt: { lte: now } }, select: { id: true, name: true, status: true } });
    rows.push({ key: "lateSends", mode: "auto", count: passed.length, items: passed.map((c) => ({ id: c.id, label: c.name, status: c.status })) });
  }

  if (isArchivedStatus(from) && rule) {
    // reopen lists what does not come back (LC rule 6)
    const [tasks, approvals] = await Promise.all([tx.task.count({ where: { projectId: project.id, statusCategory: "CANCELLED" } }), tx.approval.count({ where: { projectId: project.id, status: "CANCELLED" } })]);
    rows.push({ key: "staysCancelled", mode: "unchanged", count: tasks + approvals, items: [] });
  }

  if (to === "COMPLETED" && from === "ACTIVE") {
    const tasks = await tx.task.count({ where: sel.openTopTasks });
    rows.push({ key: "closeoutTasks", mode: "listed", count: tasks, items: [] });
  }

  const clientRecipients = to === "CANCELLED" ? await clientMembers(tx, project) : [];
  const ov = to === "CLOSED" ? overrideState(ctx, gates) : { needed: false, allowed: false, missing: [] };
  return {
    projectId: project.id,
    code: project.code,
    from,
    to,
    version: project.version,
    allowed,
    deniedReason: !rule ? "invalidTransition" : allowed ? undefined : "forbidden",
    reasonRequired: rule?.reason === "required" || (rule?.reason === "override" && ov.needed),
    rows: rows.filter((r) => r.count > 0 || r.mode === "auto"),
    gates,
    blocking: nonOverridable,
    override: ov,
    clientRecipients: clientRecipients.map((c) => ({ id: c.userId, name: nameOf(c.user, locale) ?? "" })),
    resumeTo,
  };
}

async function clientMembers(tx: Tx, project: Project) {
  const rows = await tx.projectMember.findMany({ where: { projectId: project.id, role: { in: ["CLIENT_VIEWER", "CLIENT_APPROVER"] } }, include: { user: { select: { name: true, nameAr: true } } } });
  if (!rows.length) return [];
  const active = new Set((await tx.membership.findMany({ where: { userId: { in: rows.map((r) => r.userId) }, status: "ACTIVE", clientId: project.clientId ?? "__none__" }, select: { userId: true } })).map((m) => m.userId));
  return rows.filter((r) => active.has(r.userId));
}

async function internalMembers(tx: Tx, projectId: string) {
  const rows = await tx.projectMember.findMany({ where: { projectId, role: { notIn: ["CLIENT_VIEWER", "CLIENT_APPROVER", "VENDOR"] } }, select: { userId: true } });
  if (!rows.length) return [];
  return (await tx.membership.findMany({ where: { userId: { in: rows.map((r) => r.userId) }, status: "ACTIVE" }, select: { userId: true } })).map((m) => m.userId);
}

/** notify() with the §3 fields (dedupeKey per occurrence — stored per recipient — priority, mandatory). */
const send = (tx: Tx, input: NotifyInput) => notify(tx, input);

// ── Execution ──────────────────────────────────────────────────────────────

type CascadeCounts = Record<string, number>;

/** Audit rows for many items at once (per-item rows with `meta.cause`, §1.8). */
async function auditMany(tx: Tx, ctx: ServiceContext, rows: { action: string; entityType: string; entityId: string; projectId: string; summary?: string; before?: unknown; after?: unknown; meta?: Record<string, unknown> }[]) {
  if (!rows.length) return;
  await tx.auditEvent.createMany({
    data: rows.map((r) => ({
      organizationId: ctx.orgId,
      actorId: ctx.userId === "system" ? null : ctx.userId,
      actorName: ctx.userName,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      projectId: r.projectId,
      summary: r.summary?.slice(0, 500),
      before: (r.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (r.after ?? undefined) as Prisma.InputJsonValue | undefined,
      meta: (r.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: ctx.request?.ip ?? null,
      userAgent: ctx.request?.userAgent?.slice(0, 300) ?? null,
    })),
  });
}

/** Open tasks → the system `cancelled` status of their workflow; recurrence stops. Returns the tasks moved. */
async function cancelOpenTasks(tx: Tx, ctx: ServiceContext, project: Project, cause: string) {
  const sel = selectors(project.id, new Date());
  const tasks = await tx.task.findMany({ where: sel.openTasks, select: { id: true, status: true, ownerId: true, workstreamId: true, title: true, number: true } });
  if (!tasks.length) return tasks;
  const workstreams = await tx.workstream.findMany({ where: { projectId: project.id }, select: { id: true, statuses: true } });
  const cancelledKey = (wsId: string | null) => withCancelled(workstreams.find((w) => w.id === wsId)?.statuses as StatusDef[] | undefined).find((s) => s.category === "CANCELLED")!.key;
  const byKey = new Map<string, string[]>();
  for (const t of tasks) {
    const k = cancelledKey(t.workstreamId);
    byKey.set(k, [...(byKey.get(k) ?? []), t.id]);
  }
  for (const [key, ids] of byKey) {
    await tx.task.updateMany({ where: { id: { in: ids }, statusCategory: { in: [...OPEN_TASK] } }, data: { status: key, statusCategory: "CANCELLED", completedAt: null, recurrence: Prisma.DbNull, version: { increment: 1 } } });
  }
  await auditMany(tx, ctx, tasks.map((t) => ({ action: "task.status", entityType: "TASK", entityId: t.id, projectId: project.id, summary: `#${t.number} ${t.title}`.slice(0, 200), before: { status: t.status }, after: { status: cancelledKey(t.workstreamId) }, meta: { cause } })));
  return tasks;
}

async function cancelCampaigns(tx: Tx, ctx: ServiceContext, project: Project, where: Prisma.InvitationCampaignWhereInput, cause: string) {
  const campaigns = await tx.invitationCampaign.findMany({ where, select: { id: true, name: true, status: true } });
  if (!campaigns.length) return { campaigns: 0, jobs: 0 };
  const ids = campaigns.map((c) => c.id);
  await tx.invitationCampaign.updateMany({ where: { id: { in: ids } }, data: { status: "CANCELLED", version: { increment: 1 } } });
  const jobs = await tx.messageJob.updateMany({ where: { status: "QUEUED", invitation: { campaignId: { in: ids } } }, data: { status: "CANCELLED" } });
  await auditMany(tx, ctx, campaigns.map((c) => ({ action: "campaign.cancel", entityType: "CAMPAIGN", entityId: c.id, projectId: project.id, summary: c.name, before: { status: c.status }, after: { status: "CANCELLED" }, meta: { cause } })));
  return { campaigns: campaigns.length, jobs: jobs.count };
}

async function cancelDeliveries(tx: Tx, ctx: ServiceContext, project: Project, cause: string) {
  const sel = selectors(project.id, new Date());
  const rows = await tx.delivery.findMany({ where: sel.cancellableDeliveries, select: { id: true, status: true, trackingCode: true } });
  if (!rows.length) return 0;
  const ids = rows.map((d) => d.id);
  const now = new Date();
  await tx.delivery.updateMany({ where: { id: { in: ids } }, data: { status: "CANCELLED", agentId: null, version: { increment: 1 } } });
  await tx.deliveryAssignment.updateMany({ where: { deliveryId: { in: ids }, unassignedAt: null }, data: { unassignedAt: now, reason: cause } });
  await tx.deliveryEvent.createMany({ data: rows.map((d) => ({ organizationId: ctx.orgId, deliveryId: d.id, fromStatus: d.status, toStatus: "CANCELLED" as const, actorId: ctx.userId === "system" ? null : ctx.userId, reason: cause.toUpperCase(), source: "SYSTEM" })) });
  await auditMany(tx, ctx, rows.map((d) => ({ action: "delivery.status_change", entityType: "DELIVERY", entityId: d.id, projectId: project.id, summary: d.trackingCode, before: { status: d.status }, after: { status: "CANCELLED" }, meta: { cause } })));
  return rows.length;
}

/** The §1.3 cascade, in the caller's transaction. Returns counts per row (audited as `project.cancel_cascade`). */
async function runCancelCascade(tx: Tx, ctx: ServiceContext, project: Project, reason: string, notifyClient: boolean) {
  const cause = "project_cancelled";
  const now = new Date();
  const sel = selectors(project.id, now);
  const counts: CascadeCounts = {};
  const tasks = await cancelOpenTasks(tx, ctx, project, cause);
  counts.tasks = tasks.length;
  counts.approvals = await cancelPendingApprovalsTx(tx, ctx, sel.cascadeApprovals, { reason: "project cancelled", cause });
  const c = await cancelCampaigns(tx, ctx, project, sel.cancellableCampaigns, cause);
  counts.campaigns = c.campaigns;
  counts.queuedMessages = c.jobs;
  counts.deliveries = await cancelDeliveries(tx, ctx, project, cause);

  // deliveries in a driver's car: escalated, never cancelled; the agent is told to return (mandatory)
  const inCar = await tx.delivery.findMany({ where: sel.inCarDeliveries, select: { id: true, status: true, agentId: true, trackingCode: true } });
  if (inCar.length) {
    await tx.delivery.updateMany({ where: { id: { in: inCar.map((d) => d.id) } }, data: { escalatedAt: now, escalationNote: cause, version: { increment: 1 } } });
    await tx.deliveryEvent.createMany({ data: inCar.map((d) => ({ organizationId: ctx.orgId, deliveryId: d.id, fromStatus: d.status, toStatus: d.status, actorId: ctx.userId === "system" ? null : ctx.userId, reason: "ESCALATED", note: cause, source: "SYSTEM" })) });
    for (const agentId of new Set(inCar.map((d) => d.agentId).filter((x): x is string => !!x))) {
      await send(tx, { orgId: ctx.orgId, userIds: [agentId], type: "project.cancelled", titleKey: "projects.lifecycle.notices.returnToOffice", params: { code: project.code, count: inCar.filter((d) => d.agentId === agentId).length }, link: "/field", entityType: "PROJECT", entityId: project.id, mandatory: true, priority: "HIGH", dedupeKey: `project.cancelled:return:${project.id}:${now.toISOString()}` });
    }
  }
  counts.inCarDeliveries = inCar.length;

  const pos = await tx.purchaseOrder.findMany({ where: sel.cancellablePOs, select: { id: true, code: true, status: true } });
  if (pos.length) {
    await tx.purchaseOrder.updateMany({ where: { id: { in: pos.map((p) => p.id) } }, data: { status: "CANCELLED" } });
    await auditMany(tx, ctx, pos.map((p) => ({ action: "po.status", entityType: "PURCHASE_ORDER", entityId: p.id, projectId: project.id, summary: `${p.code}: ${p.status} → CANCELLED`, meta: { cause } })));
  }
  counts.purchaseOrders = pos.length;
  const listedPOs = await tx.purchaseOrder.findMany({ where: sel.listedPOs, select: { createdById: true } });
  counts.vendorCancellation = listedPOs.length;

  const issued = await tx.workOrder.findMany({ where: sel.issuedWOs, select: { id: true, title: true, vendorId: true, createdById: true } });
  if (issued.length) {
    await tx.workOrder.updateMany({ where: { id: { in: issued.map((w) => w.id) }, status: "ISSUED" }, data: { status: "CANCELLED" } });
    await auditMany(tx, ctx, issued.map((w) => ({ action: "workorder.status", entityType: "WORK_ORDER", entityId: w.id, projectId: project.id, summary: `${w.title}: ISSUED → CANCELLED`, meta: { cause } })));
  }
  counts.workOrders = issued.length;
  const running = await tx.workOrder.findMany({ where: { OR: [sel.runningWOs, sel.deliveredWOs] }, select: { id: true, title: true, vendorId: true, createdById: true, status: true } });
  counts.runningWorkOrders = running.length;
  // the vendor's users: cancelled orders, and "await instruction" for the ones under way
  const vendorIds = [...new Set([...issued, ...running.filter((w) => w.status !== "DELIVERED")].map((w) => w.vendorId))];
  if (vendorIds.length) {
    const vendorUsers = await tx.membership.findMany({ where: { vendorId: { in: vendorIds }, status: "ACTIVE" }, select: { userId: true, vendorId: true } });
    for (const v of vendorIds) {
      const users = vendorUsers.filter((u) => u.vendorId === v).map((u) => u.userId);
      const cancelled = issued.filter((w) => w.vendorId === v).length;
      const waiting = running.filter((w) => w.vendorId === v && w.status !== "DELIVERED").length;
      if (cancelled) await send(tx, { orgId: ctx.orgId, userIds: users, type: "project.cancelled", titleKey: "projects.lifecycle.notices.vendorCancelled", params: { code: project.code, count: cancelled }, link: "/work-orders", entityType: "PROJECT", entityId: project.id, dedupeKey: `project.cancelled:vendor:${project.id}:${v}:${now.toISOString()}` });
      if (waiting) await send(tx, { orgId: ctx.orgId, userIds: users, type: "project.cancelled", titleKey: "projects.lifecycle.notices.vendorAwait", params: { code: project.code, count: waiting }, link: "/work-orders", entityType: "PROJECT", entityId: project.id, dedupeKey: `project.cancelled:vendor-await:${project.id}:${v}:${now.toISOString()}` });
    }
  }

  const eventIds = await eventIdsOf(tx, project.id);
  const shifts = eventIds.length ? await tx.shift.findMany({ where: sel.futureShifts(eventIds), select: { id: true, role: true, userId: true } }) : [];
  if (shifts.length) {
    await tx.shift.updateMany({ where: { id: { in: shifts.map((s) => s.id) }, status: "SCHEDULED" }, data: { status: "CANCELLED" } });
    await auditMany(tx, ctx, shifts.map((s) => ({ action: "shift.status", entityType: "SHIFT", entityId: s.id, projectId: project.id, summary: `${s.role}: CANCELLED`, meta: { cause } })));
  }
  counts.shifts = shifts.length;

  const events = await tx.event.findMany({ where: sel.closableEvents, select: { id: true, name: true, phase: true } });
  if (events.length) {
    await tx.event.updateMany({ where: { id: { in: events.map((e) => e.id) } }, data: { phase: "CLOSED", version: { increment: 1 } } });
    await auditMany(tx, ctx, events.map((e) => ({ action: "event.phase", entityType: "EVENT", entityId: e.id, projectId: project.id, summary: `${e.name}: ${e.phase} → CLOSED`, before: { phase: e.phase }, after: { phase: "CLOSED" }, meta: { cause } })));
  }
  counts.events = events.length;

  const guests = await tx.guest.findMany({ where: sel.cancellableGuests, select: { id: true, attendance: true } });
  if (guests.length) {
    await tx.guest.updateMany({ where: { id: { in: guests.map((g) => g.id) } }, data: { attendance: "CANCELLED", version: { increment: 1 } } });
    await auditMany(tx, ctx, guests.map((g) => ({ action: "guest.attendance", entityType: "GUEST", entityId: g.id, projectId: project.id, before: { attendance: g.attendance }, after: { attendance: "CANCELLED" }, meta: { cause } })));
  }
  counts.guests = guests.length;

  counts.changeRequests = await declineChangeRequests(tx, ctx, project, `Project cancelled: ${reason}`, cause);

  // §1.7: everyone holding open items, the PMs and the creators of listed POs/WOs (in-car agents were told above)
  const pms = await activePMs(tx, project.id);
  const holders = [...tasks.map((t) => t.ownerId), ...shifts.map((s) => s.userId), ...listedPOs.map((p) => p.createdById), ...running.map((w) => w.createdById), ...pms];
  await send(tx, { orgId: ctx.orgId, userIds: holders, type: "project.cancelled", titleKey: "projects.lifecycle.notices.cancelled", params: { code: project.code, name: project.name }, link: `/projects/${project.id}`, entityType: "PROJECT", entityId: project.id, excludeUserId: ctx.userId, priority: "HIGH", dedupeKey: `project.cancelled:${project.id}:${now.toISOString()}` });
  if (notifyClient) {
    const clients = await clientMembers(tx, project);
    await send(tx, { orgId: ctx.orgId, userIds: clients.map((c) => c.userId), type: "project.cancelled", titleKey: "projects.lifecycle.notices.cancelledClient", params: { name: project.nameEn ?? project.name, code: project.code }, link: `/projects/${project.id}`, entityType: "PROJECT", entityId: project.id, dedupeKey: `project.cancelled:client:${project.id}:${now.toISOString()}` });
    counts.clientNotified = clients.length;
  }
  return counts;
}

async function declineChangeRequests(tx: Tx, ctx: ServiceContext, project: Project, response: string, cause: string) {
  const crs = await tx.changeRequest.findMany({ where: selectors(project.id, new Date()).openChangeRequests, select: { id: true, title: true, status: true } });
  if (!crs.length) return 0;
  await tx.changeRequest.updateMany({ where: { id: { in: crs.map((c) => c.id) } }, data: { status: "DECLINED", response: response.slice(0, 2000), respondedById: ctx.userId === "system" ? null : ctx.userId } });
  await auditMany(tx, ctx, crs.map((c) => ({ action: "change_request.respond", entityType: "CHANGE_REQUEST", entityId: c.id, projectId: project.id, summary: c.title, before: { status: c.status }, after: { status: "DECLINED" }, meta: { cause } })));
  return crs.length;
}

/** Close with override (§1.4): what each unmet gate's override changes. */
async function runCloseOverride(tx: Tx, ctx: ServiceContext, project: Project, reason: string, open: GateRow[]) {
  const cause = "project_closed";
  const sel = selectors(project.id, new Date());
  const counts: CascadeCounts = {};
  const has = (g: string) => open.some((x) => x.gate === g);
  if (has("G1")) counts.tasks = (await cancelOpenTasks(tx, ctx, project, cause)).length;
  if (has("G2")) counts.approvals = await cancelPendingApprovalsTx(tx, ctx, sel.nonFinancialApprovals, { reason: `project closed: ${reason}`, cause });
  if (has("G3")) counts.deliveries = await cancelDeliveries(tx, ctx, project, cause);
  if (has("G4")) counts.campaigns = (await cancelCampaigns(tx, ctx, project, { projectId: project.id, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } }, cause)).campaigns;
  if (has("G9")) counts.changeRequests = await declineChangeRequests(tx, ctx, project, reason, cause);
  return counts;
}

/**
 * Sets a project's status (§1): transition table and roles, gates, reason, compare-and-set on
 * `Project.version`, the cascade / override / resume effects, audit and notices — one transaction.
 */
export async function setProjectStatus(ctx: ServiceContext, projectId: string, status: LifecycleTarget | ProjectStatus, opts: Omit<StatusChangeInput, "id" | "status"> = {}) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
    const project = scope.project;
    const from = effectiveStatus(project.status);
    const to = effectiveStatus(status) as LifecycleTarget;
    if (!(LIFECYCLE_TARGETS as readonly string[]).includes(to)) throw new ValidationError("errors.invalidTransition");
    if (from === to && project.status === to) return project;
    const resumeTo = from === "ON_HOLD" ? await resumeTarget(tx, projectId) : null;
    const rule = ruleFor(from, to, resumeTo);
    if (!rule) throw new ValidationError("errors.invalidTransition");
    if (!mayMove(ctx, scope, rule)) throw new ForbiddenError();
    const now = new Date();
    const gates = await gatesFor(tx, project, to, now);
    const blocking = gates.filter((g) => !g.ok && !g.overridable);
    if (blocking.length) {
      const key = to === "ACTIVE" ? "errors.activationGate" : to === "COMPLETED" ? "errors.completionGate" : to === "CANCELLED" ? "errors.liveEventBlocksCancel" : "errors.gateNotOverridable";
      throw new ValidationError(key, { gates: gateList(blocking) });
    }
    const reason = opts.reason?.trim() || null;
    const open = gates.filter((g) => !g.ok);
    const override = to === "CLOSED" && open.length > 0;
    if (rule.reason === "required" || override) {
      if (!reasonSchema.safeParse(reason ?? "").success) throw new ValidationError(override ? "errors.closeGatesOpen" : "errors.reasonRequired", { reason: ["errors.reasonRequired"], ...(override ? { gates: gateList(open) } : {}) });
    }
    if (override) {
      if (!can(ctx, "project.delete")) throw new ForbiddenError();
      const missing = open.filter((g) => g.needs && !can(ctx, g.needs));
      if (missing.length) throw new ValidationError("errors.overrideNeedsFinance", { gates: gateList(missing) });
    }

    // compare-and-set on the version the user loaded (LC rule 2, §6); a stale form gets the conflict
    const archived = isArchivedStatus(to);
    const updated = await casUpdate<Project>({
      tx, ctx, model: "project", id: projectId, version: opts.version, entityType: "PROJECT",
      data: { status: to, archivedAt: archived ? now : null, statusReason: reason, statusChangedAt: now, statusChangedById: ctx.userId === "system" ? null : ctx.userId },
    });

    await audit(tx, ctx, { action: "project.status", entityType: "PROJECT", entityId: projectId, projectId, summary: reason ?? undefined, before: { status: project.status }, after: { status: to }, meta: { reason, ...(opts.resumeOn ? { resumeOn: opts.resumeOn } : {}) } });

    let counts: CascadeCounts | null = null;
    if (to === "CANCELLED") {
      counts = await runCancelCascade(tx, ctx, updated, reason!, opts.notifyClient ?? true);
      await audit(tx, ctx, { action: "project.cancel_cascade", entityType: "PROJECT", entityId: projectId, projectId, summary: reason!, meta: { counts } });
    } else if (override) {
      counts = await runCloseOverride(tx, ctx, updated, reason!, open);
      await audit(tx, ctx, { action: "project.close_override", entityType: "PROJECT", entityId: projectId, projectId, summary: reason!, meta: { gates: Object.fromEntries(open.map((g) => [g.gate, g.count])), counts } });
      const directors = await tx.membership.findMany({ where: { organizationId: ctx.orgId, status: "ACTIVE", role: { baseRole: { in: ["OWNER", "OPS_DIRECTOR"] } } }, select: { userId: true } });
      await send(tx, { orgId: ctx.orgId, userIds: directors.map((d) => d.userId), type: "project.closed", titleKey: "projects.lifecycle.notices.closedOverride", params: { code: project.code, name: project.name, gates: gateList(open).join(", ") }, link: `/projects/${projectId}`, entityType: "PROJECT", entityId: projectId, excludeUserId: ctx.userId, dedupeKey: `project.closed:${projectId}:${now.toISOString()}` });
    }

    if (from === "ON_HOLD" && to !== "CANCELLED") await resumeEffects(tx, ctx, updated, project.statusChangedAt ?? now, now);
    if (isArchivedStatus(from)) await audit(tx, ctx, { action: "project.reopen", entityType: "PROJECT", entityId: projectId, projectId, summary: reason ?? undefined, before: { status: from }, after: { status: to } });

    // §1.7: hold / resume / complete / reopen → internal project members, in-app
    if (to !== "CANCELLED" && to !== "CLOSED") {
      const members = await internalMembers(tx, projectId);
      const reopen = isArchivedStatus(from) || (from === "COMPLETED" && to === "ACTIVE");
      await send(tx, {
        orgId: ctx.orgId, userIds: members, type: reopen ? "project.reopened" : "project.status_changed", titleKey: reopen ? "projects.lifecycle.notices.reopened" : `projects.lifecycle.notices.status.${to}`,
        params: { code: project.code, name: project.name, status: to }, link: `/projects/${projectId}`, entityType: "PROJECT", entityId: projectId, excludeUserId: ctx.userId, dedupeKey: `project.status:${projectId}:${to}:${now.toISOString()}`,
      });
    }
    if (to === "COMPLETED") await emit(tx, ctx, "project.completed", { projectId, title: updated.name, code: updated.code, link: `/projects/${projectId}` });
    return updated;
  }, { timeout: 120_000 });
}

/**
 * Resume (LC rule 8): scheduled sends whose time passed during the hold go back to DRAFT and their
 * approval is superseded (the send time was part of what was approved); the PMs get one notice.
 * Pending approvals' due dates move by the hold's duration (the SLA clock paused, §3.4).
 */
async function resumeEffects(tx: Tx, ctx: ServiceContext, project: Project, heldAt: Date, now: Date) {
  const late = await tx.invitationCampaign.findMany({ where: { projectId: project.id, status: "SCHEDULED", scheduledAt: { lte: now } }, select: { id: true, name: true } });
  for (const c of late) {
    const r = await tx.invitationCampaign.updateMany({ where: { id: c.id, status: "SCHEDULED" }, data: { status: "DRAFT", version: { increment: 1 } } });
    if (!r.count) continue;
    await supersedeApprovalsTx(tx, ctx, "CAMPAIGN", c.id, "send time passed while on hold", { cause: "project_resumed" });
    await audit(tx, ctx, { action: "campaign.approval_invalidated", entityType: "CAMPAIGN", entityId: c.id, projectId: project.id, summary: c.name, before: { status: "SCHEDULED" }, after: { status: "DRAFT" }, meta: { reason: "send time passed while on hold", cause: "project_resumed" } });
  }
  if (late.length) {
    await send(tx, { orgId: ctx.orgId, userIds: await activePMs(tx, project.id), type: "project.status_changed", titleKey: "projects.lifecycle.notices.lateSends", params: { code: project.code, count: late.length, names: late.map((c) => c.name).join("، ").slice(0, 300) }, link: `/projects/${project.id}/digital`, entityType: "PROJECT", entityId: project.id, priority: "HIGH", dedupeKey: `project.resume.late:${project.id}:${now.toISOString()}` });
  }
  const pausedMs = Math.max(0, now.getTime() - heldAt.getTime());
  if (pausedMs > 0) await tx.$executeRaw`UPDATE "Approval" SET "dueAt" = "dueAt" + (${pausedMs} * interval '1 millisecond') WHERE "projectId" = ${project.id} AND "organizationId" = ${ctx.orgId} AND status = 'PENDING' AND "dueAt" IS NOT NULL`;
}
