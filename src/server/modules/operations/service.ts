import type { Prisma } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { can, computeProjectScope, projectVisibilityWhere, type ProjectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { approvalsWithoutApprover, listApprovalsAwaitingDecision } from "@/server/modules/approvals/service";
import { campaignSendState } from "@/server/modules/digital/send-state";
import { importLeaseState } from "@/server/modules/delivery/imports/service";
import { loadFinanceSummaries } from "@/server/modules/finance/forecast";
import { loadProjectHealth, type ProjectHealth } from "@/server/modules/projects/health";
import { riyadhDayStart } from "@/lib/format";
import * as C from "./criteria";

/**
 * Operations read model: the "what needs me now" board for directors and PMs, and the person's
 * own commitments (My work). Every count is taken from the same `where` that produces its list.
 */

const scoped = (ctx: ServiceContext) => ({ orgId: ctx.orgId, userId: ctx.userId });
const LIST_CAP = 200;

export type Awaiting = Awaited<ReturnType<typeof listApprovalsAwaitingDecision>>[number];

interface ScopedProject {
  id: string;
  code: string;
  name: string;
  clientName: string | null;
  eventStartAt: Date | null;
  deadline: Date | null;
  managers: string[];
  scope: ProjectScope;
}

const personName = (ctx: ServiceContext, u: { name: string; nameAr: string | null } | null | undefined) => (u ? (ctx.locale === "ar" ? u.nameAr : null) ?? u.name : null);

/** Active projects (not closed, cancelled, completed or on hold) the caller may see, with their scope. */
async function loadActiveProjects(tx: Tx, ctx: ServiceContext): Promise<ScopedProject[]> {
  const rows = await tx.project.findMany({
    where: { ...projectVisibilityWhere(ctx), ...C.activeProjectWhere },
    include: {
      client: { select: { name: true } },
      members: { where: { OR: [{ userId: ctx.userId }, { role: "MANAGER" }] }, include: { user: { select: { name: true, nameAr: true } } } },
    },
    orderBy: [{ eventStartAt: "asc" }, { createdAt: "desc" }],
    take: 500,
  });
  const out: ScopedProject[] = [];
  for (const p of rows) {
    let scope: ProjectScope;
    try {
      scope = computeProjectScope(ctx, p, p.members.find((m) => m.userId === ctx.userId) ?? null);
    } catch {
      continue;
    }
    if (scope.clientView || scope.fieldOnly) continue;
    out.push({
      id: p.id,
      code: p.code,
      name: (ctx.locale === "en" && p.nameEn) || p.name,
      clientName: p.client?.name ?? null,
      eventStartAt: p.eventStartAt,
      deadline: p.deadline,
      managers: p.members.filter((m) => m.role === "MANAGER").map((m) => personName(ctx, m.user)!),
      scope,
    });
  }
  return out;
}

/** Task visibility across many projects: whole project, assigned workstreams, or own tasks only. */
function visibleTasks(ctx: ServiceContext, projects: ScopedProject[]): Prisma.TaskWhereInput {
  const whole = projects.filter((p) => p.scope.taskScope === "all" && !p.scope.workstreamIds.length).map((p) => p.id);
  const ors: Prisma.TaskWhereInput[] = whole.length ? [{ projectId: { in: whole } }] : [];
  for (const p of projects) {
    if (p.scope.taskScope === "assigned") ors.push({ projectId: p.id, OR: [{ ownerId: ctx.userId }, { collaborators: { some: { userId: ctx.userId } } }] });
    else if (p.scope.workstreamIds.length) ors.push({ projectId: p.id, workstreamId: { in: p.scope.workstreamIds } });
  }
  return ors.length ? { OR: ors } : { id: { in: [] } };
}

// ── Board ──────────────────────────────────────────────────────────────────

export type ExceptionKind =
  | "incident" | "overdueTask" | "approvalOverdue" | "readiness" | "deliveryLate" | "deliveryFailed" | "blockedTask" | "unownedTask" | "milestone" | "overContract" | "overPlan"
  // Milestone 2 stewardship rows (BUSINESS_RULES §1.3, §1.6, §2.2, §4.3)
  | "noApprover" | "selfApproved" | "unownedAfterDeparture" | "pmChanged" | "onHold" | "openCommitment" | "stalledWork";
export const EXCEPTION_ORDER: ExceptionKind[] = ["incident", "overdueTask", "approvalOverdue", "noApprover", "readiness", "deliveryLate", "deliveryFailed", "stalledWork", "blockedTask", "unownedAfterDeparture", "unownedTask", "milestone", "pmChanged", "onHold", "overContract", "overPlan", "openCommitment", "selfApproved"];
export type ExceptionAction = "open" | "assign" | "review" | "acknowledge" | "dispatch" | "chase" | "prepare";
export type ExceptionGroupKey = "tasks" | "decisions" | "events" | "delivery" | "money";
export const EXCEPTION_GROUP: Record<ExceptionKind, ExceptionGroupKey> = {
  incident: "events", readiness: "events", overdueTask: "tasks", blockedTask: "tasks", unownedTask: "tasks", milestone: "tasks",
  approvalOverdue: "decisions", deliveryLate: "delivery", deliveryFailed: "delivery", overContract: "money", overPlan: "money",
  noApprover: "decisions", selfApproved: "decisions", unownedAfterDeparture: "tasks", pmChanged: "tasks", onHold: "tasks", openCommitment: "money", stalledWork: "delivery",
};

/** Self-approvals stay visible this long (§4.3); a PM change this long (§2.2 HO rule 6). */
const SELF_APPROVED_DAYS = 30;
const PM_CHANGED_DAYS = 7;

export interface ExceptionRow {
  kind: ExceptionKind;
  id: string;
  title: string;
  project: { id: string; code: string; name: string };
  /** responsible person; null with `ownerExpected` = a gap */
  owner: string | null;
  ownerExpected: boolean;
  /** the date the row's age or lateness refers to */
  at: Date | null;
  tone: "danger" | "warning" | "neutral";
  /** aggregated rows (deliveries per campaign, budget lines) */
  count?: number;
  /** structured, language-neutral details for the UI to phrase */
  meta: Record<string, string | number | boolean | null>;
  /** path below /o/[org] */
  href: string;
  action: ExceptionAction;
}

export interface ExceptionGroup {
  kind: ExceptionKind;
  /** items behind the group (tasks, approvals, incidents, deliveries, events, milestones, projects) */
  count: number;
  rows: ExceptionRow[];
}

const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / C.DAY_MS);

async function loadExceptions(tx: Tx, ctx: ServiceContext, projects: ScopedProject[], now: Date): Promise<ExceptionGroup[]> {
  const ids = projects.map((p) => p.id);
  const pmap = new Map(projects.map((p) => [p.id, p]));
  const proj = (id: string) => {
    const p = pmap.get(id)!;
    return { id: p.id, code: p.code, name: p.name };
  };
  if (!ids.length) return [];
  const tasksVisible = visibleTasks(ctx, projects);
  const taskSelect = { id: true, number: true, title: true, projectId: true, dueAt: true, priority: true, clientVisible: true, owner: { select: { name: true, nameAr: true } } } as const;
  const overdueWhere: Prisma.TaskWhereInput = { AND: [C.overdueTaskWhere(ids, now), tasksVisible] };
  const unownedWhere: Prisma.TaskWhereInput = { AND: [C.unownedSoonTaskWhere(ids, now), tasksVisible] };
  const depWhere: Prisma.TaskDependencyWhereInput = { AND: [C.blockedByLateDependencyWhere(ids, now), { task: tasksVisible }] };
  const financeIds = projects.filter((p) => p.scope.finance).map((p) => p.id);

  const [overdueCount, overdue, unownedCount, unowned, deps, approvals, milestones, incidents, failed, lateCampaigns, readinessEvents, finance] = await Promise.all([
    tx.task.count({ where: overdueWhere }),
    tx.task.findMany({ where: overdueWhere, select: taskSelect, orderBy: [{ dueAt: "asc" }], take: LIST_CAP }),
    tx.task.count({ where: unownedWhere }),
    tx.task.findMany({ where: unownedWhere, select: taskSelect, orderBy: [{ dueAt: "asc" }], take: LIST_CAP }),
    tx.taskDependency.findMany({ where: depWhere, select: { task: { select: taskSelect }, dependsOn: { select: { number: true, title: true, dueAt: true } } }, take: 1000 }),
    tx.approval.findMany({ where: C.overdueApprovalWhere(ids, now), orderBy: { createdAt: "asc" }, take: 1000 }),
    tx.milestone.findMany({ where: C.overdueMilestoneWhere(ids, now), orderBy: { dueDate: "asc" }, take: 1000 }),
    tx.incident.findMany({ where: C.openIncidentWhere(ids), take: 1000 }),
    tx.delivery.groupBy({ by: ["projectId", "campaignId"], where: { projectId: { in: ids }, status: "FAILED_ATTEMPT" }, _count: true }),
    tx.invitationCampaign.findMany({ where: { projectId: { in: ids }, type: "PHYSICAL", status: { notIn: ["COMPLETED", "CANCELLED"] }, deliveryDeadline: { lte: new Date(now.getTime() + C.DELIVERY_DEADLINE_HOURS * C.HOUR_MS) } }, select: { id: true, name: true, projectId: true, deliveryDeadline: true } }),
    tx.event.findMany({ where: C.readinessEventWhere(ids, now), select: { id: true, name: true, nameEn: true, projectId: true, startsAt: true, phase: true } }),
    can(ctx, "finance.view") ? loadFinanceSummaries(tx, financeIds) : Promise.resolve([]),
  ]);

  const [lateDeliveries, readiness, campaignNames, userNames, requesters] = await Promise.all([
    lateCampaigns.length ? tx.delivery.groupBy({ by: ["campaignId"], where: { campaignId: { in: lateCampaigns.map((c) => c.id) }, status: { in: [...C.NOT_OUT_DELIVERY_STATUSES] } }, _count: true }) : Promise.resolve([]),
    readinessEvents.length ? tx.readinessItem.findMany({ where: { eventId: { in: readinessEvents.map((e) => e.id) } }, select: { eventId: true, status: true, ownerId: true } }) : Promise.resolve([]),
    failed.length ? tx.invitationCampaign.findMany({ where: { id: { in: failed.map((f) => f.campaignId) } }, select: { id: true, name: true } }) : Promise.resolve([]),
    tx.user.findMany({ where: { id: { in: [...new Set(incidents.map((i) => i.ownerId).filter((x): x is string => !!x))] } }, select: { id: true, name: true, nameAr: true } }),
    tx.user.findMany({ where: { id: { in: [...new Set(approvals.map((a) => a.requestedById))] } }, select: { id: true, name: true, nameAr: true } }),
  ]);

  const owner = (t: { owner: { name: string; nameAr: string | null } | null }) => personName(ctx, t.owner);
  const groups: ExceptionGroup[] = [];
  const push = (kind: ExceptionKind, count: number, rows: ExceptionRow[]) => {
    if (count > 0) groups.push({ kind, count, rows });
  };

  // incidents: CRITICAL still OPEN after 15 min first, then severity, then age
  const unacked = (i: (typeof incidents)[number]) => i.severity === "CRITICAL" && i.status === "OPEN" && now.getTime() - i.createdAt.getTime() > C.CRITICAL_UNACKED_MINUTES * 60_000;
  const incidentRows = [...incidents]
    .sort((a, b) => Number(unacked(b)) - Number(unacked(a)) || (C.SEVERITY_RANK[b.severity] ?? 0) - (C.SEVERITY_RANK[a.severity] ?? 0) || a.createdAt.getTime() - b.createdAt.getTime())
    .map<ExceptionRow>((i) => ({
      kind: "incident", id: i.id, title: i.title, project: proj(i.projectId), owner: personName(ctx, userNames.find((u) => u.id === i.ownerId)), ownerExpected: true, at: i.createdAt,
      tone: i.severity === "CRITICAL" || i.severity === "HIGH" ? "danger" : "warning", meta: { severity: i.severity, status: i.status, unacknowledged: unacked(i) },
      href: `/projects/${i.projectId}/events${i.eventId ? `/${i.eventId}?tab=incidents` : ""}`, action: i.status === "OPEN" ? "acknowledge" : "open",
    }));
  push("incident", incidents.length, incidentRows);

  // overdue: critical / client-visible first, then most days late
  const rank = (t: { priority: string; clientVisible: boolean }) => (C.PRIORITY_WEIGHT[t.priority] ?? 1) + (t.clientVisible ? 1 : 0);
  push("overdueTask", overdueCount, [...overdue].sort((a, b) => rank(b) - rank(a) || a.dueAt!.getTime() - b.dueAt!.getTime()).map((t) => ({
    kind: "overdueTask", id: t.id, title: t.title, project: proj(t.projectId), owner: owner(t), ownerExpected: true, at: t.dueAt,
    tone: t.priority === "CRITICAL" || t.clientVisible ? "danger" : "warning", meta: { number: t.number, priority: t.priority, clientVisible: t.clientVisible, daysLate: daysBetween(t.dueAt!, now) },
    href: `/tasks/${t.id}`, action: t.owner ? "chase" : "assign",
  })));

  // approvals past their due date (internal vs client)
  push("approvalOverdue", approvals.length, approvals.map((a) => {
    const due = C.approvalDueAt(a);
    return {
      kind: "approvalOverdue" as const, id: a.id, title: a.title, project: proj(a.projectId), owner: personName(ctx, requesters.find((u) => u.id === a.requestedById)), ownerExpected: false, at: due,
      tone: a.approverType === "CLIENT" ? ("warning" as const) : ("danger" as const), meta: { approverType: a.approverType, entityType: a.entityType, daysLate: daysBetween(due, now), defaultDue: a.dueAt === null },
      href: a.entityType === "TASK" ? `/tasks/${a.entityId}` : `/projects/${a.projectId}/approvals`, action: a.approverType === "CLIENT" ? ("chase" as const) : ("review" as const),
    };
  }));

  // events in the next 7 days (or live) below 80 % ready, with an issue, or without a checklist
  const readinessRows = readinessEvents.map((e) => {
    const items = readiness.filter((r) => r.eventId === e.id);
    const r = { total: items.length, ready: items.filter((x) => x.status === "READY").length, issues: items.filter((x) => x.status === "ISSUE").length, unowned: items.filter((x) => x.status !== "READY" && !x.ownerId).length };
    return { e, r };
  }).filter(({ r }) => C.readinessAtRisk(r)).sort((a, b) => a.e.startsAt.getTime() - b.e.startsAt.getTime());
  push("readiness", readinessRows.length, readinessRows.map(({ e, r }) => ({
    kind: "readiness", id: e.id, title: (ctx.locale === "en" && e.nameEn) || e.name, project: proj(e.projectId), owner: null, ownerExpected: false, at: e.startsAt,
    tone: r.issues > 0 || e.phase === "LIVE" ? "danger" : "warning", meta: { ready: r.ready, total: r.total, issues: r.issues, unowned: r.unowned, live: e.phase === "LIVE" },
    href: `/projects/${e.projectId}/events/${e.id}?tab=readiness`, action: "prepare",
  })));

  // deliveries not out with < 48 h to the campaign deadline
  const lateRows = lateCampaigns.map((c) => ({ c, n: lateDeliveries.find((d) => d.campaignId === c.id)?._count ?? 0 })).filter((x) => x.n > 0);
  push("deliveryLate", lateRows.reduce((a, x) => a + x.n, 0), lateRows.map(({ c, n }) => ({
    kind: "deliveryLate", id: c.id, title: c.name, project: proj(c.projectId), owner: null, ownerExpected: false, at: c.deliveryDeadline, count: n,
    tone: c.deliveryDeadline && c.deliveryDeadline < now ? "danger" : "warning", meta: { pastDeadline: !!c.deliveryDeadline && c.deliveryDeadline < now },
    href: `/dispatch?campaign=${c.id}`, action: "dispatch",
  })));

  // failed attempts, per campaign
  push("deliveryFailed", failed.reduce((a, f) => a + f._count, 0), failed.map((f) => ({
    kind: "deliveryFailed", id: f.campaignId, title: campaignNames.find((c) => c.id === f.campaignId)?.name ?? "—", project: proj(f.projectId), owner: null, ownerExpected: false, at: null, count: f._count,
    tone: "warning", meta: {}, href: `/projects/${f.projectId}/delivery/cards?c=${f.campaignId}&status=FAILED_ATTEMPT`, action: "open",
  })));

  // open tasks waiting on a predecessor that is itself late (one row per task)
  const byTask = new Map<string, { task: (typeof deps)[number]["task"]; late: (typeof deps)[number]["dependsOn"][] }>();
  for (const d of deps) {
    const cur = byTask.get(d.task.id) ?? { task: d.task, late: [] };
    cur.late.push(d.dependsOn);
    byTask.set(d.task.id, cur);
  }
  const blocked = [...byTask.values()].sort((a, b) => Math.min(...a.late.map((l) => l.dueAt!.getTime())) - Math.min(...b.late.map((l) => l.dueAt!.getTime())));
  push("blockedTask", blocked.length, blocked.slice(0, LIST_CAP).map(({ task: t, late }) => ({
    kind: "blockedTask", id: t.id, title: t.title, project: proj(t.projectId), owner: owner(t), ownerExpected: true, at: late[0].dueAt,
    tone: "warning", meta: { number: t.number, waitingOn: late[0].title, waitingOnNumber: late[0].number, more: late.length - 1 },
    href: `/tasks/${t.id}`, action: "open",
  })));

  // unowned, due within 14 days (≤ 3 days highlighted)
  push("unownedTask", unownedCount, unowned.map((t) => ({
    kind: "unownedTask", id: t.id, title: t.title, project: proj(t.projectId), owner: null, ownerExpected: true, at: t.dueAt,
    tone: t.dueAt!.getTime() - now.getTime() <= C.UNOWNED_URGENT_DAYS * C.DAY_MS ? "danger" : "warning", meta: { number: t.number, priority: t.priority },
    href: `/tasks/${t.id}`, action: "assign",
  })));

  push("milestone", milestones.length, milestones.map((m) => ({
    kind: "milestone", id: m.id, title: m.title, project: proj(m.projectId), owner: null, ownerExpected: false, at: m.dueDate,
    tone: "warning", meta: { daysLate: daysBetween(m.dueDate!, now), blocked: m.status === "BLOCKED" }, href: `/projects/${m.projectId}`, action: "open",
  })));

  // money: only for projects the caller can see finance for (hidden, never zero)
  const over = finance.filter((f) => f.overContract);
  push("overContract", over.length, over.map((f) => ({
    kind: "overContract", id: f.projectId, title: proj(f.projectId).name, project: proj(f.projectId), owner: null, ownerExpected: false, at: null,
    tone: "danger", meta: { margin: f.margin?.amount ?? null, planned: f.totals.planned, forecast: f.totals.forecast, contract: f.contract.revised },
    href: `/projects/${f.projectId}/finance`, action: "open",
  })));
  const overPlan = finance.filter((f) => !f.overContract && f.overPlan);
  push("overPlan", overPlan.length, overPlan.map((f) => ({
    kind: "overPlan", id: f.projectId, title: proj(f.projectId).name, project: proj(f.projectId), owner: null, ownerExpected: false, at: null, count: f.lines.filter((l) => l.overBudget).length,
    tone: "warning", meta: { overrun: f.totals.forecast - f.totals.planned }, href: `/projects/${f.projectId}/finance`, action: "open",
  })));

  for (const g of await loadStewardship(tx, ctx, projects, now)) push(g.kind, g.count, g.rows);

  return EXCEPTION_ORDER.map((k) => groups.find((g) => g.kind === k)).filter((g): g is ExceptionGroup => !!g);
}

/**
 * Milestone 2 rows: approvals nobody can decide, self-approvals under the exception (owners and
 * directors), work left unowned after a departure, PM changes, projects on hold, and open
 * commitments in archived projects (finance scope only).
 */
async function loadStewardship(tx: Tx, ctx: ServiceContext, projects: ScopedProject[], now: Date): Promise<ExceptionGroup[]> {
  const ids = projects.map((p) => p.id);
  const leader = ctx.role === "OWNER" || ctx.role === "OPS_DIRECTOR";
  const out: ExceptionGroup[] = [];
  const pmap = new Map(projects.map((p) => [p.id, p]));
  const proj = (id: string) => {
    const p = pmap.get(id);
    return p ? { id: p.id, code: p.code, name: p.name } : null;
  };

  // approvals with no eligible approver (H4, §4.3 after the exception lapses)
  const pending = ids.length ? await tx.approval.findMany({ where: { projectId: { in: ids }, status: "PENDING", approverUserId: null }, take: 300 }) : [];
  if (pending.length) {
    const full = await tx.project.findMany({ where: { id: { in: [...new Set(pending.map((a) => a.projectId))] } } });
    const stuck = await approvalsWithoutApprover(tx, ctx.orgId, pending, full);
    const finance = new Set(projects.filter((p) => p.scope.finance).map((p) => p.id));
    const rows = pending.filter((a) => stuck.has(a.id) && (finance.has(a.projectId) || !["PURCHASE_ORDER", "EXPENSE", "CHANGE_ORDER"].includes(a.entityType)));
    if (rows.length) out.push({ kind: "noApprover", count: rows.length, rows: rows.map((a) => ({ kind: "noApprover", id: a.id, title: a.title, project: proj(a.projectId)!, owner: null, ownerExpected: true, at: a.createdAt, tone: "warning", meta: { entityType: a.entityType }, href: `/projects/${a.projectId}/approvals`, action: "review" })) });
  }

  // self-approvals under the exception, for owners and directors (30 days)
  if (leader) {
    const since = new Date(now.getTime() - SELF_APPROVED_DAYS * C.DAY_MS);
    const self = await tx.approval.findMany({ where: { policyException: true, decidedAt: { gte: since } }, orderBy: { decidedAt: "desc" }, take: LIST_CAP });
    if (self.length) {
      const [ps, us] = await Promise.all([
        tx.project.findMany({ where: { id: { in: [...new Set(self.map((a) => a.projectId))] } }, select: { id: true, code: true, name: true, nameEn: true } }),
        tx.user.findMany({ where: { id: { in: [...new Set(self.map((a) => a.decidedById).filter((x): x is string => !!x))] } }, select: { id: true, name: true, nameAr: true } }),
      ]);
      out.push({
        kind: "selfApproved", count: self.length,
        rows: self.map((a) => {
          const p = ps.find((x) => x.id === a.projectId)!;
          return { kind: "selfApproved" as const, id: a.id, title: a.title, project: { id: p.id, code: p.code, name: (ctx.locale === "en" && p.nameEn) || p.name }, owner: personName(ctx, us.find((u) => u.id === a.decidedById)), ownerExpected: false, at: a.decidedAt, tone: "neutral" as const, meta: { justification: a.policyExceptionReason ?? null, entityType: a.entityType }, href: `/projects/${a.projectId}/approvals`, action: "review" as const };
        }),
      });
    }
  }

  // open tasks left unowned by a departure (HO-4), with the departed person's name
  if (ids.length) {
    const left = await tx.taskAssignmentHistory.findMany({ where: { reason: "handover", toUserId: null, task: { projectId: { in: ids }, ownerId: null, statusCategory: C.OPEN_TASK_CATEGORIES } }, include: { task: { select: { id: true, number: true, title: true, projectId: true, dueAt: true } } }, orderBy: { createdAt: "desc" }, take: LIST_CAP });
    const seen = new Set<string>();
    const rows = left.filter((h) => !seen.has(h.taskId) && seen.add(h.taskId));
    if (rows.length) {
      const people = await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.fromUserId).filter((x): x is string => !!x))] } }, select: { id: true, name: true, nameAr: true } });
      out.push({ kind: "unownedAfterDeparture", count: rows.length, rows: rows.map((h) => ({ kind: "unownedAfterDeparture" as const, id: h.task.id, title: h.task.title, project: proj(h.task.projectId)!, owner: null, ownerExpected: true, at: h.task.dueAt, tone: "warning" as const, meta: { number: h.task.number, departed: personName(ctx, people.find((u) => u.id === h.fromUserId)) }, href: `/tasks/${h.task.id}`, action: "assign" as const })) });
    }
    // the PM changed by a handover in the last 7 days
    const changes = await tx.auditEvent.findMany({ where: { projectId: { in: ids }, action: { in: ["project.member_add", "project.member_update"] }, createdAt: { gte: new Date(now.getTime() - PM_CHANGED_DAYS * C.DAY_MS) }, meta: { path: ["cause"], equals: "handover" }, after: { path: ["role"], equals: "MANAGER" } }, orderBy: { createdAt: "desc" } });
    const byProject = [...new Map(changes.map((c) => [c.projectId!, c])).values()];
    if (byProject.length) out.push({ kind: "pmChanged", count: byProject.length, rows: byProject.map((c) => ({ kind: "pmChanged" as const, id: c.projectId!, title: proj(c.projectId!)!.name, project: proj(c.projectId!)!, owner: null, ownerExpected: false, at: c.createdAt, tone: "neutral" as const, meta: {}, href: `/projects/${c.projectId}`, action: "open" as const })) });
  }

  // stalled imports and sends (§7.1, §7.2): one row for owners and directors, linking to System health
  if (leader) {
    const now2 = now;
    const [campaigns, imports] = await Promise.all([
      tx.invitationCampaign.findMany({ where: { status: { in: ["SCHEDULED", "SENDING"] } }, select: { status: true, scheduledAt: true, dispatchLeaseUntil: true, dispatchAttempts: true, updatedAt: true, projectId: true } }),
      tx.importBatch.findMany({ where: { status: { in: ["VALIDATING", "COMMITTING"] } }, select: { status: true, leaseUntil: true, updatedAt: true, attempts: true } }),
    ]);
    const statuses = campaigns.length ? new Map((await tx.project.findMany({ where: { id: { in: [...new Set(campaigns.map((c) => c.projectId))] } }, select: { id: true, status: true } })).map((p) => [p.id, p.status])) : new Map<string, string>();
    const sends = campaigns.filter((c) => {
      const st = campaignSendState(c, statuses.get(c.projectId) ?? "ACTIVE", now2);
      return st.late || st.stalled || st.paused;
    }).length;
    const stalledImports = imports.filter((b) => importLeaseState(b, now2).paused).length;
    const n = sends + stalledImports;
    if (n) out.push({ kind: "stalledWork", count: n, rows: [{ kind: "stalledWork", id: "stalled", title: "", project: { id: "", code: "", name: "" }, owner: null, ownerExpected: false, at: null, count: n, tone: "warning", meta: { sends, imports: stalledImports }, href: "/settings/health", action: "open" }] });
  }

  // projects on hold, with their reason (§1.6: listed, no exceptions raised for them)
  const held = await tx.project.findMany({ where: { ...projectVisibilityWhere(ctx), status: "ON_HOLD" }, select: { id: true, code: true, name: true, nameEn: true, statusReason: true, statusChangedAt: true }, take: LIST_CAP });
  if (held.length) out.push({ kind: "onHold", count: held.length, rows: held.map((p) => ({ kind: "onHold" as const, id: p.id, title: (ctx.locale === "en" && p.nameEn) || p.name, project: { id: p.id, code: p.code, name: (ctx.locale === "en" && p.nameEn) || p.name }, owner: null, ownerExpected: false, at: p.statusChangedAt, tone: "neutral" as const, meta: { reason: p.statusReason ?? null }, href: `/projects/${p.id}`, action: "open" as const })) });

  // open commitments in archived projects (§1.3 "listed", §1.4 G5–G7), finance scope only
  if (can(ctx, "finance.view")) {
    const archived = await tx.project.findMany({ where: { ...projectVisibilityWhere(ctx), status: { in: ["CLOSED", "CANCELLED"] } }, include: { members: { where: { userId: ctx.userId } } }, take: 500 });
    const finance = archived.filter((p) => {
      try {
        return computeProjectScope(ctx, p, p.members[0] ?? null).finance;
      } catch {
        return false;
      }
    });
    if (finance.length) {
      const fids = finance.map((p) => p.id);
      const [pos, exps, wos] = await Promise.all([
        tx.purchaseOrder.groupBy({ by: ["projectId"], where: { projectId: { in: fids }, status: { in: ["APPROVED", "ISSUED", "PARTIALLY_RECEIVED"] } }, _count: true, _sum: { amount: true, vatAmount: true } }),
        tx.expense.groupBy({ by: ["projectId"], where: { projectId: { in: fids }, status: "SUBMITTED" }, _count: true }),
        tx.workOrder.groupBy({ by: ["projectId"], where: { projectId: { in: fids }, status: { in: ["ISSUED", "ACCEPTED", "IN_PROGRESS", "DELIVERED"] } }, _count: true }),
      ]);
      const rows = finance.flatMap((p) => {
        const po = pos.find((x) => x.projectId === p.id);
        const ex = exps.find((x) => x.projectId === p.id)?._count ?? 0;
        const wo = wos.find((x) => x.projectId === p.id)?._count ?? 0;
        const n = (po?._count ?? 0) + ex + wo;
        if (!n) return [];
        const name = (ctx.locale === "en" && p.nameEn) || p.name;
        return [{ kind: "openCommitment" as const, id: p.id, title: name, project: { id: p.id, code: p.code, name }, owner: null, ownerExpected: false, at: p.statusChangedAt, count: n, tone: "warning" as const, meta: { pos: po?._count ?? 0, amount: Number(po?._sum.amount ?? 0) + Number(po?._sum.vatAmount ?? 0), expenses: ex, workOrders: wo, status: p.status }, href: `/projects/${p.id}/finance`, action: "open" as const }];
      });
      if (rows.length) out.push({ kind: "openCommitment", count: rows.length, rows });
    }
  }
  return out;
}

export interface NextEvent {
  id: string;
  name: string;
  project: { id: string; code: string; name: string };
  startsAt: Date;
  endsAt: Date;
  phase: string;
  live: boolean;
  readiness: { total: number; ready: number; issues: number };
}

async function loadNextEvents(tx: Tx, ctx: ServiceContext, projects: ScopedProject[], now: Date): Promise<{ events: NextEvent[]; beyondWindow: boolean }> {
  const ids = projects.map((p) => p.id);
  if (!ids.length) return { events: [], beyondWindow: false };
  const select = { id: true, name: true, nameEn: true, projectId: true, startsAt: true, endsAt: true, phase: true } as const;
  let beyondWindow = false;
  let events = await tx.event.findMany({ where: { projectId: { in: ids }, phase: { not: "CLOSED" }, endsAt: { gte: now }, startsAt: { lte: new Date(now.getTime() + 30 * C.DAY_MS) } }, select, orderBy: { startsAt: "asc" }, take: 8 });
  if (!events.length) {
    events = await tx.event.findMany({ where: { projectId: { in: ids }, phase: { not: "CLOSED" }, startsAt: { gt: now } }, select, orderBy: { startsAt: "asc" }, take: 1 });
    beyondWindow = events.length > 0;
  }
  const items = events.length ? await tx.readinessItem.groupBy({ by: ["eventId", "status"], where: { eventId: { in: events.map((e) => e.id) } }, _count: true }) : [];
  const pmap = new Map(projects.map((p) => [p.id, p]));
  return {
    beyondWindow,
    events: events.map((e) => {
      const r = items.filter((x) => x.eventId === e.id);
      const p = pmap.get(e.projectId)!;
      return {
        id: e.id, name: (ctx.locale === "en" && e.nameEn) || e.name, project: { id: p.id, code: p.code, name: p.name }, startsAt: e.startsAt, endsAt: e.endsAt, phase: e.phase,
        live: e.phase === "LIVE" || (e.startsAt <= now && e.endsAt >= now),
        readiness: { total: r.reduce((a, x) => a + x._count, 0), ready: r.filter((x) => x.status === "READY").reduce((a, x) => a + x._count, 0), issues: r.filter((x) => x.status === "ISSUE").reduce((a, x) => a + x._count, 0) },
      };
    }),
  };
}

export interface PortfolioRow {
  id: string;
  code: string;
  name: string;
  clientName: string | null;
  eventStartAt: Date | null;
  managers: string[];
  health: ProjectHealth;
  financeVisible: boolean;
  gaps: { unowned: number; noEventDate: boolean; noManager: boolean; noClient: boolean };
}

const LEVEL_RANK = { critical: 0, watch: 1, good: 2 } as const;

export async function operationsBoard(ctx: ServiceContext, now = new Date()) {
  const [board, awaiting] = await Promise.all([
    withTenant(scoped(ctx), async (tx) => {
      const projects = await loadActiveProjects(tx, ctx);
      const ids = projects.map((p) => p.id);
      const [exceptions, next, health, unownedByProject, anyProject] = await Promise.all([
        loadExceptions(tx, ctx, projects, now),
        loadNextEvents(tx, ctx, projects, now),
        loadProjectHealth(tx, ids, now),
        ids.length ? tx.task.groupBy({ by: ["projectId"], where: { ...C.topLevelOpenTask(ids), ownerId: null }, _count: true }) : Promise.resolve([]),
        projects.length ? Promise.resolve(true) : tx.project.count({ where: projectVisibilityWhere(ctx) }).then((n) => n > 0),
      ]);
      const portfolio: PortfolioRow[] = projects
        .map((p) => ({
          id: p.id, code: p.code, name: p.name, clientName: p.clientName, eventStartAt: p.eventStartAt, managers: p.managers, health: health.get(p.id)!, financeVisible: p.scope.finance,
          gaps: { unowned: unownedByProject.find((u) => u.projectId === p.id)?._count ?? 0, noEventDate: !p.eventStartAt, noManager: p.managers.length === 0, noClient: !p.clientName },
        }))
        .sort((a, b) => LEVEL_RANK[a.health.level] - LEVEL_RANK[b.health.level] || (a.eventStartAt?.getTime() ?? Infinity) - (b.eventStartAt?.getTime() ?? Infinity));
      const signals = await loadSignals(tx, ctx, projects);
      const setup = anyProject ? null : await loadSetup(tx, ctx);
      return { projectCount: projects.length, exceptions, nextEvents: next.events, nextEventBeyondWindow: next.beyondWindow, portfolio, signals, setup };
    }),
    listApprovalsAwaitingDecision(ctx, { limit: 100 }),
  ]);
  return { now, ...board, awaiting };
}

export type OperationsBoard = Awaited<ReturnType<typeof operationsBoard>>;

async function loadSignals(tx: Tx, ctx: ServiceContext, projects: ScopedProject[]) {
  const ids = projects.map((p) => p.id);
  if (!ids.length) return null;
  const financeIds = projects.filter((p) => p.scope.finance).map((p) => p.id);
  const [deliveries, invites, finance] = await Promise.all([
    can(ctx, "delivery.view") ? tx.delivery.groupBy({ by: ["status"], where: { projectId: { in: ids }, status: { not: "CANCELLED" } }, _count: true }) : Promise.resolve(null),
    tx.digitalInvitation.groupBy({ by: ["rsvpStatus"], where: { projectId: { in: ids }, status: { in: ["SENT", "DELIVERED", "READ"] } }, _count: true }),
    can(ctx, "finance.view") && financeIds.length ? loadFinanceSummaries(tx, financeIds) : Promise.resolve(null),
  ]);
  const sent = invites.reduce((a, r) => a + r._count, 0);
  return {
    delivery: deliveries ? { total: deliveries.reduce((a, d) => a + d._count, 0), delivered: deliveries.find((d) => d.status === "DELIVERED")?._count ?? 0 } : null,
    rsvp: sent ? { sent, responded: invites.filter((r) => r.rsvpStatus).reduce((a, r) => a + r._count, 0), attending: invites.find((r) => r.rsvpStatus === "ATTENDING")?._count ?? 0 } : null,
    finance: finance
      ? {
          contract: finance.reduce((a, f) => a + (f.contract.revised ?? 0), 0),
          planned: finance.reduce((a, f) => a + f.totals.planned, 0),
          committed: finance.reduce((a, f) => a + f.totals.committed, 0),
          actual: finance.reduce((a, f) => a + f.totals.actual, 0),
          forecast: finance.reduce((a, f) => a + f.totals.forecast, 0),
          withContract: finance.filter((f) => f.contract.revised !== null).length,
        }
      : null,
  };
}

/** First-run checklist for an agency with no projects yet. */
async function loadSetup(tx: Tx, ctx: ServiceContext) {
  const [clients, venues, members, liveChannels] = await Promise.all([
    tx.client.count(),
    tx.venue.count(),
    tx.membership.count({ where: { status: "ACTIVE" } }),
    tx.providerConfig.count({ where: { mode: "LIVE", enabled: true } }),
  ]);
  return {
    canCreate: can(ctx, "project.create"),
    canDirectory: can(ctx, "org.directory.manage"),
    canMembers: can(ctx, "org.members.manage"),
    canProviders: can(ctx, "org.manage"),
    steps: { client: clients > 0, venue: venues > 0, team: members > 1, providers: liveChannels > 0 },
  };
}

// ── My work ────────────────────────────────────────────────────────────────

export type CommitmentKind = "task" | "readiness" | "incident" | "snag" | "shift" | "cue";
export type Bucket = "overdue" | "today" | "week" | "later" | "none";
export const BUCKETS: Bucket[] = ["overdue", "today", "week", "later", "none"];

export interface Commitment {
  kind: CommitmentKind;
  id: string;
  title: string;
  project: { id: string; code: string; name: string } | null;
  /** workstream, event or booth the item belongs to */
  context: string | null;
  due: Date | null;
  bucket: Bucket;
  /** priority (tasks) or severity (incidents, snags) */
  level: string | null;
  status: string;
  number: number | null;
  clientVisible: boolean;
  blockedBy: { number: number; title: string }[];
  awaitingApproval: boolean;
  href: string;
}

function bucketOf(due: Date | null, now: Date): Bucket {
  if (!due) return "none";
  if (due < now) return "overdue";
  const tomorrow = new Date(riyadhDayStart(now).getTime() + C.DAY_MS);
  if (due < tomorrow) return "today";
  if (due < new Date(tomorrow.getTime() + 7 * C.DAY_MS)) return "week";
  return "later";
}

export async function myCommitments(ctx: ServiceContext, now = new Date()) {
  const [mine, awaiting] = await Promise.all([
    withTenant(scoped(ctx), async (tx) => {
      const archived = { status: { in: ["CLOSED", "CANCELLED", "COMPLETED"] as ("CLOSED" | "CANCELLED" | "COMPLETED")[] } };
      const liveProject = { NOT: archived, archivedAt: null };
      const todayStart = riyadhDayStart(now);
      const [tasks, readiness, incidents, shifts, cues, snags, risks, managed] = await Promise.all([
        tx.task.findMany({
          where: { statusCategory: C.OPEN_TASK_CATEGORIES, project: liveProject, OR: [{ ownerId: ctx.userId }, { collaborators: { some: { userId: ctx.userId } } }] },
          select: {
            id: true, number: true, title: true, dueAt: true, priority: true, status: true, statusCategory: true, clientVisible: true, requiresApproval: true,
            project: { select: { id: true, code: true, name: true, nameEn: true } }, workstream: { select: { name: true, nameEn: true } },
            dependencies: { where: { dependsOn: { statusCategory: C.OPEN_TASK_CATEGORIES } }, select: { dependsOn: { select: { number: true, title: true } } } },
          },
          orderBy: [{ dueAt: "asc" }],
          take: 500,
        }),
        tx.readinessItem.findMany({ where: { ownerId: ctx.userId, status: { not: "READY" } }, take: 200 }),
        tx.incident.findMany({ where: { ownerId: ctx.userId, status: { in: [...C.OPEN_INCIDENT_STATUSES] } }, orderBy: { createdAt: "asc" }, take: 200 }),
        tx.shift.findMany({ where: { userId: ctx.userId, status: { in: ["SCHEDULED", "CHECKED_IN"] }, endsAt: { gte: now }, startsAt: { lte: new Date(now.getTime() + 14 * C.DAY_MS) } }, orderBy: { startsAt: "asc" }, take: 100 }),
        tx.runOfShowItem.findMany({ where: { ownerId: ctx.userId, status: { in: ["PENDING", "STANDBY", "GO"] }, startsAt: { gte: todayStart, lt: new Date(todayStart.getTime() + 2 * C.DAY_MS) } }, orderBy: { startsAt: "asc" }, take: 100 }),
        tx.snag.findMany({ where: { assigneeId: ctx.userId, status: { in: ["OPEN", "IN_PROGRESS"] } }, include: { booth: { select: { id: true, name: true, projectId: true, handoverAt: true } } }, take: 200 }),
        tx.risk.findMany({ where: { ownerId: ctx.userId, status: { not: "CLOSED" } }, orderBy: [{ impact: "desc" }, { likelihood: "desc" }], take: 100 }),
        can(ctx, "task.assign") ? tx.projectMember.findMany({ where: { userId: ctx.userId, role: "MANAGER", project: { ...C.activeProjectWhere } }, select: { projectId: true } }) : Promise.resolve([]),
      ]);
      const eventIds = [...new Set([...readiness.map((r) => r.eventId), ...shifts.map((s) => s.eventId), ...cues.map((c) => c.eventId), ...incidents.map((i) => i.eventId).filter((x): x is string => !!x)])];
      const events = eventIds.length ? await tx.event.findMany({ where: { id: { in: eventIds } }, select: { id: true, name: true, nameEn: true, projectId: true, startsAt: true, phase: true } }) : [];
      const projectIds = [...new Set([...events.map((e) => e.projectId), ...incidents.map((i) => i.projectId), ...snags.map((s) => s.booth.projectId), ...risks.map((r) => r.projectId)])];
      const projects = projectIds.length ? await tx.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, code: true, name: true, nameEn: true, status: true, archivedAt: true } }) : [];
      const live = new Set(projects.filter((p) => !p.archivedAt && !["CLOSED", "CANCELLED", "COMPLETED"].includes(p.status)).map((p) => p.id));
      const pOf = (id: string | undefined) => {
        const p = projects.find((x) => x.id === id);
        return p ? { id: p.id, code: p.code, name: (ctx.locale === "en" && p.nameEn) || p.name } : null;
      };
      const ev = (id: string | null) => events.find((e) => e.id === id) ?? null;
      const evName = (e: { name: string; nameEn: string | null } | null) => (e ? (ctx.locale === "en" && e.nameEn) || e.name : null);
      // pending approvals on my own tasks: I'm waiting on someone else's decision
      const pendingOnMine = tasks.length ? await tx.approval.findMany({ where: { status: "PENDING", entityType: "TASK", entityId: { in: tasks.map((t) => t.id) } }, select: { entityId: true } }) : [];
      const awaitingSet = new Set(pendingOnMine.map((a) => a.entityId));

      const items: Commitment[] = [];
      for (const t of tasks) {
        items.push({
          kind: "task", id: t.id, title: t.title, project: { id: t.project.id, code: t.project.code, name: (ctx.locale === "en" && t.project.nameEn) || t.project.name },
          context: t.workstream ? (ctx.locale === "en" && t.workstream.nameEn) || t.workstream.name : null, due: t.dueAt, bucket: bucketOf(t.dueAt, now), level: t.priority, status: t.statusCategory,
          number: t.number, clientVisible: t.clientVisible, blockedBy: t.dependencies.map((d) => d.dependsOn), awaitingApproval: awaitingSet.has(t.id), href: `/tasks/${t.id}`,
        });
      }
      for (const r of readiness) {
        const e = ev(r.eventId);
        if (!e || e.phase === "CLOSED" || !live.has(e.projectId)) continue;
        const due = r.dueAt ?? e.startsAt;
        items.push({ kind: "readiness", id: r.id, title: r.label, project: pOf(e.projectId), context: evName(e), due, bucket: bucketOf(due, now), level: null, status: r.status, number: null, clientVisible: false, blockedBy: [], awaitingApproval: false, href: `/projects/${e.projectId}/events/${e.id}?tab=readiness` });
      }
      for (const i of incidents) {
        if (!live.has(i.projectId)) continue;
        const e = ev(i.eventId);
        // an open incident is always today's work
        items.push({ kind: "incident", id: i.id, title: i.title, project: pOf(i.projectId), context: evName(e), due: i.createdAt, bucket: "today", level: i.severity, status: i.status, number: null, clientVisible: false, blockedBy: [], awaitingApproval: false, href: `/projects/${i.projectId}/events${e ? `/${e.id}?tab=incidents` : ""}` });
      }
      for (const s of snags) {
        if (!live.has(s.booth.projectId)) continue;
        const due = s.booth.handoverAt;
        items.push({ kind: "snag", id: s.id, title: s.title, project: pOf(s.booth.projectId), context: s.booth.name, due, bucket: bucketOf(due, now), level: s.severity, status: s.status, number: null, clientVisible: false, blockedBy: [], awaitingApproval: false, href: `/projects/${s.booth.projectId}/production/${s.booth.id}?tab=snags` });
      }
      const tomorrow = new Date(todayStart.getTime() + C.DAY_MS);
      const onSite = [
        ...shifts.filter((s) => s.startsAt < tomorrow).map((s) => ({ kind: "shift" as const, id: s.id, title: s.role, at: s.startsAt, until: s.endsAt, location: s.location, status: s.status, event: ev(s.eventId) })),
        ...cues.filter((c) => c.startsAt < tomorrow).map((c) => ({ kind: "cue" as const, id: c.id, title: c.title, at: c.startsAt, until: new Date(c.startsAt.getTime() + c.durationMin * 60_000), location: c.location, status: c.status, event: ev(c.eventId) })),
      ]
        .filter((x) => x.event && live.has(x.event.projectId))
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map((x) => ({ ...x, eventName: evName(x.event), href: `/projects/${x.event!.projectId}/events/${x.event!.id}?tab=${x.kind === "shift" ? "staff" : "runOfShow"}`, event: undefined }));
      // later shifts join the queue by their start time
      for (const s of shifts.filter((x) => x.startsAt >= tomorrow)) {
        const e = ev(s.eventId);
        if (!e || !live.has(e.projectId)) continue;
        items.push({ kind: "shift", id: s.id, title: s.role, project: pOf(e.projectId), context: evName(e), due: s.startsAt, bucket: bucketOf(s.startsAt, now), level: null, status: s.status, number: null, clientVisible: false, blockedBy: [], awaitingApproval: false, href: `/projects/${e.projectId}/events/${e.id}?tab=staff` });
      }

      // PM: gaps in the projects I manage
      const managedIds = managed.map((m) => m.projectId);
      const gaps = managedIds.length
        ? await Promise.all([
            tx.task.groupBy({ by: ["projectId"], where: { ...C.topLevelOpenTask(managedIds), ownerId: null }, _count: true }),
            tx.task.groupBy({ by: ["projectId"], where: C.unownedForHealthWhere(managedIds, now), _count: true }),
            tx.milestone.groupBy({ by: ["projectId"], where: { projectId: { in: managedIds }, status: { not: "DONE" }, dueDate: null }, _count: true }),
            tx.project.findMany({ where: { id: { in: managedIds } }, select: { id: true, code: true, name: true, nameEn: true, eventStartAt: true } }),
          ]).then(([unowned, soon, undated, ps]) =>
            ps
              .map((p) => ({
                project: { id: p.id, code: p.code, name: (ctx.locale === "en" && p.nameEn) || p.name },
                unowned: unowned.find((u) => u.projectId === p.id)?._count ?? 0,
                unownedSoon: soon.find((u) => u.projectId === p.id)?._count ?? 0,
                undatedMilestones: undated.find((u) => u.projectId === p.id)?._count ?? 0,
                noEventDate: !p.eventStartAt,
              }))
              .filter((g) => g.unowned || g.undatedMilestones || g.noEventDate),
          )
        : [];

      const waiting = items.filter((i) => i.kind === "task" && (i.blockedBy.length > 0 || i.awaitingApproval));
      const ownedRisks = risks.filter((r) => live.has(r.projectId)).map((r) => ({ id: r.id, title: r.title, project: pOf(r.projectId), score: r.likelihood * r.impact, status: r.status, href: `/projects/${r.projectId}` }));
      const order = (i: Commitment) => (i.kind === "incident" ? 0 : 1);
      items.sort((a, b) => BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket) || order(a) - order(b) || (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity));
      return { items, onSite, gaps, waiting, risks: ownedRisks };
    }),
    listApprovalsAwaitingDecision(ctx, { limit: 100 }),
  ]);
  return { now, ...mine, awaiting };
}

export type MyCommitments = Awaited<ReturnType<typeof myCommitments>>;
