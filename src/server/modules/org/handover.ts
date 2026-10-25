import { z } from "zod";
import type { Project } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { can, computeProjectScope, isArchivedStatus } from "@/server/authz/policy";
import type { Tx } from "@/server/db/tenant";
import { ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { cancelPendingApprovalsTx, mayDecide, resolveApproverSet } from "@/server/modules/approvals/service";
import { decidePolicyFor, loadApprovalSettings, type ApprovalSettings } from "@/server/modules/approvals/policy";
import { notify, type NotifyInput } from "@/server/modules/notifications/notify";

/**
 * Departure and handover (BUSINESS_RULES §2). `memberHoldings` is the single query behind both the
 * preview and the execution (HO-9); `executeHandover` runs inside the suspend / revoke transaction.
 */

export const HOLDING_KEYS = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11", "H12", "H13", "H14", "H15"] as const;
export type HoldingKey = (typeof HOLDING_KEYS)[number];
/** Rows a person chooses a replacement for (H14 is always automatic, H4/H5/H15 are informational). */
export const ASSIGNABLE_KEYS = ["H1", "H2", "H3", "H6", "H7", "H8", "H9", "H10", "H11", "H12", "H13"] as const;
export type AssignableKey = (typeof ASSIGNABLE_KEYS)[number];
const UNOWNED = "UNOWNED";

const OPEN_TASK = { notIn: ["DONE", "CANCELLED"] as ("DONE" | "CANCELLED")[] };

export interface HoldingItem {
  id: string;
  label: string;
  projectId: string | null;
  projectCode: string | null;
  status?: string | null;
  dueAt?: Date | null;
  /** H6 only: the departing person is the last active PM of this non-archived project */
  lastManager?: boolean;
}

export interface HoldingRow {
  key: HoldingKey;
  count: number;
  items: HoldingItem[];
}

export interface Holdings {
  userId: string;
  rows: HoldingRow[];
  /** projects where a replacement PM is mandatory (HO rule 3) */
  lastManagerOf: { projectId: string; code: string }[];
}

export const handoverSchema = z.object({
  /** one replacement for every category */
  replacementId: z.string().nullish(),
  /** per category: a member id, or "UNOWNED" to leave the items without an owner */
  perCategory: z.partialRecord(z.enum(ASSIGNABLE_KEYS), z.string()).optional(),
  /** H5 items to withdraw instead of keeping */
  withdrawRequested: z.array(z.string()).max(500).optional(),
  /** the counts the dialog showed; a mismatch means the holdings changed meanwhile (UX note 2) */
  expected: z.partialRecord(z.enum(HOLDING_KEYS), z.number().int()).optional(),
});
export type HandoverOptions = z.output<typeof handoverSchema>;

async function archivedProjectIds(tx: Tx) {
  const rows = await tx.project.findMany({ where: { status: { in: ["CLOSED", "CANCELLED"] } }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Lightweight service context for evaluating policy on someone else's behalf. */
async function contextOf(tx: Tx, orgId: string, userId: string): Promise<ServiceContext | null> {
  const m = await tx.membership.findFirst({ where: { organizationId: orgId, userId, status: "ACTIVE" }, include: { role: true, user: { select: { name: true } } } });
  if (!m) return null;
  return {
    userId, userName: m.user.name, locale: "ar", orgId, orgSlug: "", orgName: "", membershipId: m.id, role: m.role.baseRole, roleKey: m.role.key,
    clientId: m.clientId, vendorId: m.vendorId, permissions: new Set(m.role.permissions), isPlatformAdmin: false,
  };
}

/** Who may receive internal work: an active, internal member (clients, vendors and drivers can't). */
const isInternal = (c: ServiceContext) => !["CLIENT", "CLIENT_APPROVER", "VENDOR", "FIELD_AGENT"].includes(c.role);

/**
 * Everything a person holds (§2.1, H1–H15), grouped with items. Archived projects are excluded:
 * they are read-only and their work is closed by the cascade.
 */
export async function memberHoldings(tx: Tx, orgId: string, userId: string, now = new Date()): Promise<Holdings> {
  const archived = await archivedProjectIds(tx);
  const live = { notIn: archived };
  const [tasks, collabs, designated, requested, managed, incidents, risks, shifts, deliveries, imports] = await Promise.all([
    tx.task.findMany({ where: { ownerId: userId, statusCategory: OPEN_TASK, projectId: live }, select: { id: true, number: true, title: true, status: true, dueAt: true, projectId: true }, orderBy: { dueAt: "asc" } }),
    tx.taskCollaborator.findMany({ where: { userId, task: { statusCategory: OPEN_TASK, projectId: live } }, select: { id: true, task: { select: { id: true, number: true, title: true, projectId: true, status: true } } } }),
    tx.approval.findMany({ where: { approverUserId: userId, status: "PENDING", projectId: live }, select: { id: true, title: true, projectId: true, status: true, dueAt: true } }),
    tx.approval.findMany({ where: { requestedById: userId, status: "PENDING", projectId: live }, select: { id: true, title: true, projectId: true, status: true, dueAt: true } }),
    tx.projectMember.findMany({ where: { userId, role: "MANAGER", projectId: live }, select: { id: true, projectId: true } }),
    tx.incident.findMany({ where: { ownerId: userId, status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] } }, select: { id: true, title: true, projectId: true, status: true } }),
    tx.risk.findMany({ where: { ownerId: userId, status: { not: "CLOSED" }, projectId: live }, select: { id: true, title: true, projectId: true, status: true } }),
    tx.shift.findMany({ where: { userId, status: "SCHEDULED", startsAt: { gt: now } }, select: { id: true, role: true, eventId: true, startsAt: true, status: true } }),
    tx.delivery.findMany({ where: { agentId: userId, status: { in: ["ASSIGNED", "OUT_FOR_DELIVERY", "FAILED_ATTEMPT", "RESCHEDULED"] } }, select: { id: true, trackingCode: true, projectId: true, status: true } }),
    tx.importBatch.findMany({ where: { createdById: userId, status: { in: ["VALIDATING", "COMMITTING"] } }, select: { id: true, fileName: true, projectId: true, status: true } }),
  ]);
  const [readiness, cues, snags, escorts] = await Promise.all([
    tx.readinessItem.findMany({ where: { ownerId: userId, status: { not: "READY" } }, select: { id: true, label: true, eventId: true, status: true, dueAt: true } }),
    tx.runOfShowItem.findMany({ where: { ownerId: userId, status: { in: ["PENDING", "STANDBY"] } }, select: { id: true, title: true, eventId: true, status: true, startsAt: true } }),
    tx.snag.findMany({ where: { assigneeId: userId, status: { in: ["OPEN", "IN_PROGRESS"] } }, select: { id: true, title: true, status: true, booth: { select: { projectId: true } } } }),
    tx.protocolAssignment.findMany({ where: { escortId: userId, status: { not: "COMPLETED" } }, select: { id: true, status: true, guest: { select: { projectId: true, nameEn: true, nameAr: true } } } }),
  ]);
  const eventIds = [...new Set([...readiness.map((r) => r.eventId), ...cues.map((c) => c.eventId), ...shifts.map((s) => s.eventId)])];
  const events = eventIds.length ? await tx.event.findMany({ where: { id: { in: eventIds } }, select: { id: true, projectId: true, name: true } }) : [];
  const eventProject = new Map(events.map((e) => [e.id, e.projectId]));
  const projectIds = [
    ...new Set([
      ...tasks.map((t) => t.projectId), ...collabs.map((c) => c.task.projectId), ...designated.map((a) => a.projectId), ...requested.map((a) => a.projectId), ...managed.map((m) => m.projectId),
      ...incidents.map((i) => i.projectId), ...risks.map((r) => r.projectId), ...deliveries.map((d) => d.projectId), ...imports.map((i) => i.projectId), ...events.map((e) => e.projectId),
      ...snags.map((s) => s.booth.projectId), ...escorts.map((e) => e.guest.projectId),
    ]),
  ];
  const projects = projectIds.length ? await tx.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, code: true, status: true } }) : [];
  const code = (id: string | null | undefined) => projects.find((p) => p.id === id)?.code ?? null;
  const archivedSet = new Set(archived);
  const notArchived = (pid: string | null | undefined) => !!pid && !archivedSet.has(pid);

  // H6: last active PM of a non-archived project (inactive members are ignored by every pool)
  const managedIds = managed.map((m) => m.projectId);
  const otherPMs = managedIds.length ? await tx.projectMember.findMany({ where: { projectId: { in: managedIds }, role: "MANAGER", userId: { not: userId } }, select: { projectId: true, userId: true } }) : [];
  const activeOthers = otherPMs.length ? new Set((await tx.membership.findMany({ where: { userId: { in: [...new Set(otherPMs.map((p) => p.userId))] }, status: "ACTIVE" }, select: { userId: true } })).map((m) => m.userId)) : new Set<string>();
  const lastManagerOf = managed.filter((m) => !otherPMs.some((o) => o.projectId === m.projectId && activeOthers.has(o.userId))).map((m) => ({ projectId: m.projectId, code: code(m.projectId) ?? "" }));

  // H4: pending approvals (not designated) that only this person could decide
  const onlyDecider = await soleDecisions(tx, orgId, userId, archived);

  const row = (key: HoldingKey, items: HoldingItem[]): HoldingRow => ({ key, count: items.length, items });
  const rows: HoldingRow[] = [
    row("H1", tasks.map((t) => ({ id: t.id, label: `#${t.number} ${t.title}`, projectId: t.projectId, projectCode: code(t.projectId), status: t.status, dueAt: t.dueAt }))),
    row("H2", collabs.map((c) => ({ id: c.id, label: `#${c.task.number} ${c.task.title}`, projectId: c.task.projectId, projectCode: code(c.task.projectId), status: c.task.status }))),
    row("H3", designated.map((a) => ({ id: a.id, label: a.title, projectId: a.projectId, projectCode: code(a.projectId), status: a.status, dueAt: a.dueAt }))),
    row("H4", onlyDecider.map((a) => ({ id: a.id, label: a.title, projectId: a.projectId, projectCode: code(a.projectId) ?? a.projectCode, status: a.status }))),
    row("H5", requested.map((a) => ({ id: a.id, label: a.title, projectId: a.projectId, projectCode: code(a.projectId), status: a.status, dueAt: a.dueAt }))),
    row("H6", managed.map((m) => ({ id: m.id, label: code(m.projectId) ?? "", projectId: m.projectId, projectCode: code(m.projectId), lastManager: lastManagerOf.some((l) => l.projectId === m.projectId) }))),
    row("H7", incidents.map((i) => ({ id: i.id, label: i.title, projectId: i.projectId, projectCode: code(i.projectId), status: i.status }))),
    row("H8", readiness.filter((r) => notArchived(eventProject.get(r.eventId))).map((r) => ({ id: r.id, label: r.label, projectId: eventProject.get(r.eventId) ?? null, projectCode: code(eventProject.get(r.eventId)), status: r.status, dueAt: r.dueAt }))),
    row("H9", snags.filter((s) => notArchived(s.booth.projectId)).map((s) => ({ id: s.id, label: s.title, projectId: s.booth.projectId, projectCode: code(s.booth.projectId), status: s.status }))),
    row("H10", risks.map((r) => ({ id: r.id, label: r.title, projectId: r.projectId, projectCode: code(r.projectId), status: r.status }))),
    row("H11", cues.filter((c) => notArchived(eventProject.get(c.eventId))).map((c) => ({ id: c.id, label: c.title, projectId: eventProject.get(c.eventId) ?? null, projectCode: code(eventProject.get(c.eventId)), status: c.status, dueAt: c.startsAt }))),
    row("H12", shifts.filter((s) => notArchived(eventProject.get(s.eventId))).map((s) => ({ id: s.id, label: s.role, projectId: eventProject.get(s.eventId) ?? null, projectCode: code(eventProject.get(s.eventId)), status: s.status, dueAt: s.startsAt }))),
    row("H13", escorts.filter((e) => notArchived(e.guest.projectId)).map((e) => ({ id: e.id, label: e.guest.nameEn ?? e.guest.nameAr, projectId: e.guest.projectId, projectCode: code(e.guest.projectId), status: e.status }))),
    row("H14", deliveries.map((d) => ({ id: d.id, label: d.trackingCode, projectId: d.projectId, projectCode: code(d.projectId), status: d.status }))),
    row("H15", imports.map((i) => ({ id: i.id, label: i.fileName, projectId: i.projectId, projectCode: code(i.projectId), status: i.status }))),
  ];
  return { userId, rows, lastManagerOf };
}

/** H4: PENDING approvals without a designated approver where this person is the only eligible decider. */
async function soleDecisions(tx: Tx, orgId: string, userId: string, archived: string[]) {
  const me = await contextOf(tx, orgId, userId);
  if (!me) return [];
  const pending = await tx.approval.findMany({ where: { status: "PENDING", approverUserId: null, requestedById: { not: userId }, projectId: { notIn: archived } }, take: 500 });
  if (!pending.length) return [];
  const projects = await tx.project.findMany({ where: { id: { in: [...new Set(pending.map((a) => a.projectId))] } } });
  const members = await tx.projectMember.findMany({ where: { userId, projectId: { in: projects.map((p) => p.id) } } });
  const settings = await loadApprovalSettings(tx, orgId);
  const out: { id: string; title: string; projectId: string; projectCode: string; status: string }[] = [];
  for (const a of pending) {
    const project = projects.find((p) => p.id === a.projectId)!;
    let scope;
    try {
      scope = computeProjectScope(me, project, members.find((m) => m.projectId === project.id) ?? null);
    } catch {
      continue;
    }
    if (!mayDecide(me, scope, a, null)) continue;
    const { eligible } = await resolveApproverSet(tx, project, a, { settings, excludeUserIds: [userId] });
    if (!eligible.length) out.push({ id: a.id, title: a.title, projectId: a.projectId, projectCode: project.code, status: a.status });
  }
  return out;
}

export interface HandoverResult {
  moved: Partial<Record<HoldingKey, number>>;
  unowned: Partial<Record<HoldingKey, number>>;
  /** H12 shifts left open because the replacement has a clashing shift (HO-6) */
  shiftClashes: string[];
  /** H3 approvals cancelled because nobody else could decide them */
  approvalsCancelled: number;
}

const notice = (tx: Tx, input: NotifyInput) => notify(tx, input);

/**
 * Executes the handover inside the caller's transaction (HO rule 1): every reassignment is validated
 * first; if any fails, nothing changes and the failing rows are returned as field errors.
 */
export async function executeHandover(tx: Tx, ctx: ServiceContext, departing: { userId: string; name: string }, opts: HandoverOptions): Promise<HandoverResult> {
  const now = new Date();
  const h = await memberHoldings(tx, ctx.orgId, departing.userId, now);
  const rowOf = (k: HoldingKey) => h.rows.find((r) => r.key === k)!;
  // the holdings changed since the dialog opened: refresh, never act on a stale picture
  if (opts.expected) {
    const changed = Object.entries(opts.expected).filter(([k, n]) => rowOf(k as HoldingKey).count !== n).map(([k]) => k);
    if (changed.length) throw new ValidationError("errors.staleWrite", Object.fromEntries(changed.map((k) => [k, ["errors.staleWrite"]])));
  }
  const targetOf = (k: AssignableKey): string | null => {
    const v = opts.perCategory?.[k] ?? opts.replacementId ?? UNOWNED;
    return v === UNOWNED ? null : v;
  };

  // ── validate every replacement before writing anything ──
  const failures: Record<string, string[]> = {};
  const contexts = new Map<string, ServiceContext | null>();
  for (const k of ASSIGNABLE_KEYS) {
    const t = targetOf(k);
    if (!t || !rowOf(k).count) continue;
    if (t === departing.userId) failures[k] = ["errors.replacementNotEligible"];
    if (!contexts.has(t)) contexts.set(t, await contextOf(tx, ctx.orgId, t));
    const c = contexts.get(t);
    if (!c || !isInternal(c)) failures[k] = ["errors.replacementNotEligible"];
  }
  // HO rule 3: a replacement PM (holding project.manage) is mandatory where they are the last PM
  const pmTarget = targetOf("H6");
  const pmCtx = pmTarget ? contexts.get(pmTarget) ?? null : null;
  if (h.lastManagerOf.length && (!pmCtx || !can(pmCtx, "project.manage"))) {
    failures.H6 = [pmTarget ? "errors.replacementNotEligible" : "errors.lastManager"];
    if (!pmTarget) throw new ValidationError("errors.lastManager", { ...failures, projects: h.lastManagerOf.map((p) => p.code) });
  }
  if (Object.keys(failures).length) throw new ValidationError("errors.replacementNotEligible", failures);

  const projects = new Map<string, Project>();
  const projectOf = async (id: string) => {
    if (!projects.has(id)) projects.set(id, await tx.project.findUniqueOrThrow({ where: { id } }));
    return projects.get(id)!;
  };
  /** a replacement not yet on the project joins as MEMBER with no capability flags (HO rule 2) */
  const ensureOnProject = async (userId: string, projectId: string | null) => {
    if (!projectId) return;
    const existing = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (existing) return;
    const pm = await tx.projectMember.create({ data: { organizationId: ctx.orgId, projectId, userId, role: "MEMBER", addedById: ctx.userId === "system" ? null : ctx.userId } });
    await audit(tx, ctx, { action: "project.member_add", entityType: "PROJECT_MEMBER", entityId: pm.id, projectId, after: { userId, role: "MEMBER" }, meta: { cause: "handover", from: departing.userId } });
  };

  const result: HandoverResult = { moved: {}, unowned: {}, shiftClashes: [], approvalsCancelled: 0 };
  const received = new Map<string, Map<string, number>>(); // replacement → project code → items
  const unownedByProject = new Map<string, number>();
  const credit = (to: string | null, item: HoldingItem, k: HoldingKey) => {
    if (to) {
      result.moved[k] = (result.moved[k] ?? 0) + 1;
      const per = received.get(to) ?? new Map<string, number>();
      per.set(item.projectCode ?? "—", (per.get(item.projectCode ?? "—") ?? 0) + 1);
      received.set(to, per);
    } else {
      result.unowned[k] = (result.unowned[k] ?? 0) + 1;
      if (item.projectId) unownedByProject.set(item.projectId, (unownedByProject.get(item.projectId) ?? 0) + 1);
    }
  };
  const cause = { cause: "handover", from: departing.userId };

  // H6 first, so the replacement PM is on each project before work moves to them
  if (pmTarget && pmCtx) {
    for (const item of rowOf("H6").items) {
      const projectId = item.projectId!;
      const flags = { canApprove: can(pmCtx, "approval.decide"), canExport: can(pmCtx, "export.data"), canViewFinance: can(pmCtx, "finance.view"), canViewVip: can(pmCtx, "vip.viewSensitive") };
      const before = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: pmTarget } } });
      const pm = await tx.projectMember.upsert({ where: { projectId_userId: { projectId, userId: pmTarget } }, create: { organizationId: ctx.orgId, projectId, userId: pmTarget, role: "MANAGER", ...flags, addedById: ctx.userId === "system" ? null : ctx.userId }, update: { role: "MANAGER", ...flags } });
      await audit(tx, ctx, { action: before ? "project.member_update" : "project.member_add", entityType: "PROJECT_MEMBER", entityId: pm.id, projectId, before: before ? { role: before.role } : undefined, after: { userId: pmTarget, role: "MANAGER" }, meta: cause });
      credit(pmTarget, item, "H6");
    }
  }

  // H1 tasks (history reason "handover")
  const t1 = targetOf("H1");
  for (const item of rowOf("H1").items) {
    if (t1) await ensureOnProject(t1, item.projectId);
    const r = await tx.task.updateMany({ where: { id: item.id, ownerId: departing.userId }, data: { ownerId: t1, escalationLevel: 0, version: { increment: 1 } } });
    if (!r.count) continue;
    await tx.taskAssignmentHistory.create({ data: { organizationId: ctx.orgId, taskId: item.id, fromUserId: departing.userId, toUserId: t1, changedById: ctx.userId === "system" ? departing.userId : ctx.userId, reason: "handover" } });
    credit(t1, item, "H1");
  }

  // H2 collaborations: removed; the replacement is added as collaborator when chosen
  const t2 = targetOf("H2");
  for (const item of rowOf("H2").items) {
    const c = await tx.taskCollaborator.findUnique({ where: { id: item.id }, select: { taskId: true } });
    if (!c) continue;
    await tx.taskCollaborator.delete({ where: { id: item.id } });
    if (t2) {
      await ensureOnProject(t2, item.projectId);
      await tx.taskCollaborator.upsert({ where: { taskId_userId: { taskId: c.taskId, userId: t2 } }, create: { organizationId: ctx.orgId, taskId: c.taskId, userId: t2 }, update: {} });
    }
    await audit(tx, ctx, { action: "task.collaborators", entityType: "TASK", entityId: c.taskId, projectId: item.projectId, after: { removed: departing.userId, added: t2 }, meta: cause });
    credit(t2, item, "H2");
  }

  // H3 designated approvals: to the replacement if they may decide; else back to the pool; an empty pool cancels with revert
  const t3 = targetOf("H3");
  const t3ctx = t3 ? contexts.get(t3) ?? null : null;
  const settings: ApprovalSettings = await loadApprovalSettings(tx, ctx.orgId);
  for (const item of rowOf("H3").items) {
    const a = await tx.approval.findUnique({ where: { id: item.id } });
    if (!a || a.status !== "PENDING") continue;
    const project = await projectOf(a.projectId);
    let to: string | null = null;
    if (t3 && t3ctx) {
      const pmRow = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId: a.projectId, userId: t3 } } });
      let scope = null;
      try {
        scope = computeProjectScope(t3ctx, project, pmRow);
      } catch {
        scope = null;
      }
      if (mayDecide(t3ctx, scope, { ...a, approverUserId: t3 }, await creatorOf(tx, a.entityType, a.entityId), await decidePolicyFor(tx, settings, project, a))) to = t3;
    }
    if (!to) {
      const pool = await resolveApproverSet(tx, project, { ...a, approverUserId: null }, { settings, excludeUserIds: [departing.userId] });
      if (!pool.eligible.length) {
        // clear the designation first: the departing person receives nothing (§2.3)
        await tx.approval.update({ where: { id: a.id }, data: { approverUserId: null } });
        result.approvalsCancelled += await cancelPendingApprovalsTx(tx, ctx, { id: a.id }, { reason: "designated approver left; nobody else can decide", revert: true, action: "approval.cancel_inactive_approver", cause: "handover" });
        // the requester was told by the cancellation; the PMs hear about it once too (never twice)
        await notice(tx, { orgId: ctx.orgId, userIds: (await activePMs(tx, a.projectId)).filter((u) => u !== a.requestedById && u !== departing.userId), type: "approval.cancelled", titleKey: "tasks.approvalNotices.cancelled", params: { title: a.title }, link: `/projects/${a.projectId}/approvals`, entityType: a.entityType, entityId: a.entityId, excludeUserId: ctx.userId });
        continue;
      }
      await tx.approval.update({ where: { id: a.id }, data: { approverUserId: null } });
      await audit(tx, ctx, { action: "approval.reassigned", entityType: a.entityType, entityId: a.entityId, projectId: a.projectId, summary: a.title, meta: { approvalId: a.id, to: null, ...cause } });
      await notice(tx, { orgId: ctx.orgId, userIds: [a.requestedById, ...pool.notify], type: "approval.reassigned", titleKey: "org.handover.notices.approvalRerouted", params: { title: a.title }, link: `/projects/${a.projectId}/approvals`, entityType: a.entityType, entityId: a.entityId, excludeUserId: ctx.userId, dedupeKey: `approval.reassigned:${a.id}:${now.toISOString()}` });
      credit(null, item, "H3");
      continue;
    }
    await tx.approval.update({ where: { id: a.id }, data: { approverUserId: to } });
    await audit(tx, ctx, { action: "approval.reassigned", entityType: a.entityType, entityId: a.entityId, projectId: a.projectId, summary: a.title, meta: { approvalId: a.id, to, ...cause } });
    await notice(tx, { orgId: ctx.orgId, userIds: [a.requestedById], type: "approval.reassigned", titleKey: "org.handover.notices.approvalRerouted", params: { title: a.title }, link: `/projects/${a.projectId}/approvals`, entityType: a.entityType, entityId: a.entityId, excludeUserId: ctx.userId, dedupeKey: `approval.reassigned:${a.id}:${now.toISOString()}` });
    credit(to, item, "H3");
  }

  // H5 requested approvals stay PENDING (separation of duties keeps requestedById); optional withdraw
  const withdraw = new Set(opts.withdrawRequested ?? []);
  for (const item of rowOf("H5").items.filter((i) => withdraw.has(i.id))) {
    await cancelPendingApprovalsTx(tx, ctx, { id: item.id }, { reason: "requester left", revert: true, action: "approval.withdraw", cause: "handover" });
  }

  // simple owner moves: H7 incidents, H8 readiness, H9 snags, H10 risks, H11 cues, H13 escorts
  const simple: [AssignableKey, (id: string, to: string | null) => Promise<{ count: number }>, string][] = [
    ["H7", (id, to) => tx.incident.updateMany({ where: { id, ownerId: departing.userId }, data: { ownerId: to } }), "INCIDENT"],
    ["H8", (id, to) => tx.readinessItem.updateMany({ where: { id, ownerId: departing.userId }, data: { ownerId: to } }), "READINESS_ITEM"],
    ["H9", (id, to) => tx.snag.updateMany({ where: { id, assigneeId: departing.userId }, data: { assigneeId: to } }), "SNAG"],
    ["H10", (id, to) => tx.risk.updateMany({ where: { id, ownerId: departing.userId }, data: { ownerId: to, version: { increment: 1 } } }), "RISK"],
    ["H11", (id, to) => tx.runOfShowItem.updateMany({ where: { id, ownerId: departing.userId }, data: { ownerId: to } }), "RUN_OF_SHOW"],
    ["H13", (id, to) => tx.protocolAssignment.updateMany({ where: { id, escortId: departing.userId }, data: { escortId: to } }), "PROTOCOL_ASSIGNMENT"],
  ];
  for (const [k, move, entityType] of simple) {
    const to = targetOf(k);
    for (const item of rowOf(k).items) {
      if (to) await ensureOnProject(to, item.projectId);
      if (!(await move(item.id, to)).count) continue;
      await audit(tx, ctx, { action: "handover.item", entityType, entityId: item.id, projectId: item.projectId, summary: item.label.slice(0, 200), after: { owner: to }, meta: { ...cause, holding: k } });
      credit(to, item, k);
    }
  }

  // H12 future shifts: to the replacement unless it clashes with one of theirs (then left open and flagged)
  const t12 = targetOf("H12");
  for (const item of rowOf("H12").items) {
    const s = await tx.shift.findUnique({ where: { id: item.id } });
    if (!s || s.userId !== departing.userId) continue;
    let to = t12;
    if (to) {
      const clash = await tx.shift.count({ where: { userId: to, status: { in: ["SCHEDULED", "CHECKED_IN"] }, startsAt: { lt: s.endsAt }, endsAt: { gt: s.startsAt } } });
      if (clash) {
        to = null;
        result.shiftClashes.push(s.id);
      } else await ensureOnProject(to, item.projectId);
    }
    await tx.shift.update({ where: { id: s.id }, data: { userId: to } });
    await audit(tx, ctx, { action: "shift.update", entityType: "SHIFT", entityId: s.id, projectId: item.projectId, summary: s.role, after: { userId: to }, meta: { ...cause, ...(t12 && !to ? { clash: true } : {}) } });
    credit(to, item, "H12");
  }

  await audit(tx, ctx, {
    action: "member.handover", entityType: "MEMBERSHIP", entityId: departing.userId,
    summary: `${Object.values(result.moved).reduce((n, x) => n + (x ?? 0), 0)} moved, ${Object.values(result.unowned).reduce((n, x) => n + (x ?? 0), 0)} unowned`,
    meta: { userId: departing.userId, counts: Object.fromEntries(h.rows.map((r) => [r.key, r.count])), moved: result.moved, unowned: result.unowned, replacements: { all: opts.replacementId ?? null, perCategory: opts.perCategory ?? {} }, shiftClashes: result.shiftClashes },
  });

  // one consolidated, mandatory notice per replacement; one notice per project for unowned items
  for (const [to, per] of received) {
    const total = [...per.values()].reduce((n, x) => n + x, 0);
    await notice(tx, { orgId: ctx.orgId, userIds: [to], type: "handover.assigned", titleKey: "org.handover.notices.received", params: { count: total, name: departing.name, projects: [...per.keys()].join(", ").slice(0, 200) }, link: "/my-work", mandatory: true, priority: "HIGH", dedupeKey: `handover.assigned:${departing.userId}:${to}:${now.toISOString()}` });
  }
  for (const [projectId, n] of unownedByProject) {
    const p = await projectOf(projectId);
    if (isArchivedStatus(p.status)) continue;
    await notice(tx, { orgId: ctx.orgId, userIds: (await activePMs(tx, projectId)).filter((u) => u !== departing.userId), type: "handover.unowned", titleKey: "org.handover.notices.unowned", params: { count: n, name: departing.name, code: p.code }, link: `/projects/${projectId}`, entityType: "PROJECT", entityId: projectId, dedupeKey: `handover.unowned:${departing.userId}:${projectId}:${now.toISOString()}` });
  }
  return result;
}

async function activePMs(tx: Tx, projectId: string) {
  const pms = await tx.projectMember.findMany({ where: { projectId, role: "MANAGER" }, select: { userId: true } });
  if (!pms.length) return [];
  return (await tx.membership.findMany({ where: { userId: { in: pms.map((p) => p.userId) }, status: "ACTIVE" }, select: { userId: true } })).map((m) => m.userId);
}

async function creatorOf(tx: Tx, entityType: string, entityId: string) {
  if (entityType === "PURCHASE_ORDER") return (await tx.purchaseOrder.findUnique({ where: { id: entityId }, select: { createdById: true } }))?.createdById ?? null;
  if (entityType === "EXPENSE") return (await tx.expense.findUnique({ where: { id: entityId }, select: { submittedById: true } }))?.submittedById ?? null;
  if (entityType === "CHANGE_ORDER") return (await tx.changeOrder.findUnique({ where: { id: entityId }, select: { createdById: true } }))?.createdById ?? null;
  return null;
}

