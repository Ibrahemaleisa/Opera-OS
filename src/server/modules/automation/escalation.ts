import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { QUIET_PROJECT_STATUSES } from "@/server/authz/policy";
import type { Tx } from "@/server/db/tenant";
import { resolveApproverSet } from "@/server/modules/approvals/service";
import { audit } from "@/server/modules/audit/audit";
import { notify } from "@/server/modules/notifications/notify";
import type { NotificationPriority } from "@/server/modules/notifications/types";
import { emit, type DomainEventType } from "./outbox";

/**
 * Escalation ladders (BUSINESS_RULES §3.4), run by the scheduler tick. Each tier fires once per
 * occurrence:
 *  - an *occurrence* is identified by its anchor (a task's due date, or the time it was re-assigned
 *    after falling due; a work order's due date; an incident's report or manual-escalation time; a
 *    campaign's deadline). A changed anchor starts a new occurrence;
 *  - every tier that fires writes an audit marker (`<entity>.escalation`, meta.tier + meta.anchor),
 *    which is what "already sent" means, plus an outbox event for automation hooks;
 *  - notices carry occurrence dedupe keys (§3.3 rule 2), so even a replayed tier never notifies a
 *    person twice;
 *  - notices for the same recipient, type and tier within one tick are consolidated (§3.3 rule 3).
 *
 * Escalation markers (`Task.escalationLevel`, `Task.escalatedAt`, `Incident.escalationLevel`) are not
 * user-editable content and do NOT bump `version`: an escalation never makes a user's open form stale.
 */

const H = 3600_000;
const MIN = 60_000;

/** BUSINESS_RULES §0 constants. */
export const APPROVAL_SLA_HOURS_DEFAULT = 48;
export const APPROVAL_REMINDER_BEFORE_DUE_H = 24;
export const APPROVAL_REMINDER_MIN_SLA_H = 36;
export const TASK_LADDER_H = { L1: 0, L2: 24, L3: 72 } as const;
export const WORK_ORDER_LADDER_H = { L1: 0, L2: 24, L3: 72 } as const;
export const WORK_ORDER_NOT_ACCEPTED_H = 48;
export const INCIDENT_ACK_MIN: Record<string, number[]> = { CRITICAL: [15, 60], HIGH: [60], MEDIUM: [240], LOW: [] };
export const DEADLINE_LADDER_H = { T1: -48, T2: -24, T3: 0 } as const;
export const UNOWNED_DUE_WINDOW_H = 72;

/** No reminders or escalations at all (§1.6). COMPLETED keeps the closeout tail (see each ladder). */
const PAUSED = QUIET_PROJECT_STATUSES.filter((s) => s !== "COMPLETED");
const QUIET = QUIET_PROJECT_STATUSES;

const CREATION_SLACK_MS = 5_000;
const BATCH = { tasks: 500, approvals: 300, workOrders: 300, incidents: 200, campaigns: 100 } as const;

// ── Recipients ───────────────────────────────────────────────────────────────

/** Active-member lookups for one tick, cached. "Directors" fall back to owners (§0). */
class Directory {
  private pmCache = new Map<string, string[]>();
  private roles?: { userId: string; baseRole: string; permissions: string[]; vendorId: string | null }[];
  constructor(private tx: Tx) {}

  private async members() {
    this.roles ??= (await this.tx.membership.findMany({ where: { status: "ACTIVE" }, select: { userId: true, vendorId: true, role: { select: { baseRole: true, permissions: true } } } })).map((m) => ({
      userId: m.userId,
      vendorId: m.vendorId,
      baseRole: m.role.baseRole,
      permissions: m.role.permissions,
    }));
    return this.roles;
  }
  async isActive(userId: string | null | undefined) {
    return !!userId && (await this.members()).some((m) => m.userId === userId);
  }
  async owners() {
    return (await this.members()).filter((m) => m.baseRole === "OWNER").map((m) => m.userId);
  }
  async directors() {
    const d = (await this.members()).filter((m) => m.baseRole === "OPS_DIRECTOR").map((m) => m.userId);
    return d.length ? d : this.owners();
  }
  async financeApprovers() {
    return (await this.members()).filter((m) => m.permissions.includes("finance.approve")).map((m) => m.userId);
  }
  async vendorUsers(vendorId: string) {
    return (await this.members()).filter((m) => m.vendorId === vendorId && m.baseRole === "VENDOR").map((m) => m.userId);
  }
  /** The project's active PMs. */
  async pms(projectId: string) {
    if (!this.pmCache.has(projectId)) {
      const rows = await this.tx.projectMember.findMany({ where: { projectId, role: "MANAGER" }, select: { userId: true } });
      const active = new Set((await this.members()).map((m) => m.userId));
      this.pmCache.set(projectId, rows.map((r) => r.userId).filter((u) => active.has(u)));
    }
    return this.pmCache.get(projectId)!;
  }
  /** PMs → directors → owners (§3.1 rule 4 fallback). */
  async pmsOrFallback(projectId: string) {
    const p = await this.pms(projectId);
    return p.length ? p : this.directors();
  }
}

// ── Consolidated notices ─────────────────────────────────────────────────────

interface Item {
  /** occurrence dedupe key of this item at this tier, e.g. `task.overdue:<id>:<anchor>:L2` */
  key: string;
  type: string;
  level: number;
  titleKey: string;
  params: Record<string, string | number | null>;
  link: string;
  entityType: string;
  entityId: string;
  priority?: NotificationPriority;
  /** how several items of this type and tier read as one notice */
  many: { titleKey: string; link: string };
}

/** Collects (recipient, item) pairs during a tick and sends one notice per recipient, type and tier. */
class NoticeBatch {
  private byRecipient = new Map<string, Item[]>();
  add(recipients: string[], item: Item) {
    for (const r of new Set(recipients)) {
      const list = this.byRecipient.get(r) ?? [];
      if (!list.some((i) => i.key === item.key)) list.push(item);
      this.byRecipient.set(r, list);
    }
  }
  async flush(tx: Tx, orgId: string): Promise<number> {
    let n = 0;
    for (const [userId, items] of this.byRecipient) {
      const groups = new Map<string, Item[]>();
      for (const i of items) groups.set(`${i.type}|${i.level}`, [...(groups.get(`${i.type}|${i.level}`) ?? []), i]);
      for (const group of groups.values()) {
        const first = group[0];
        const priority = group.some((i) => i.priority === "CRITICAL") ? "CRITICAL" : group.some((i) => i.priority === "HIGH") ? "HIGH" : "NORMAL";
        if (group.length === 1) {
          n += await notify(tx, { orgId, userIds: [userId], type: first.type, titleKey: first.titleKey, params: first.params, link: first.link, entityType: first.entityType, entityId: first.entityId, dedupeKey: first.key, priority, escalationLevel: first.level });
        } else {
          const digest = createHash("sha256").update(group.map((i) => i.key).sort().join("|")).digest("hex").slice(0, 20);
          n += await notify(tx, {
            orgId,
            userIds: [userId],
            type: first.type,
            titleKey: first.many.titleKey,
            params: { count: group.length },
            link: first.many.link,
            dedupeKey: `${first.type}:L${first.level}:batch:${digest}`,
            priority,
            escalationLevel: first.level,
          });
        }
      }
    }
    this.byRecipient.clear();
    return n;
  }
}

// ── Markers ──────────────────────────────────────────────────────────────────

interface Marker {
  tier: string;
  anchor: string;
}

async function markers(tx: Tx, entityType: string, action: string, ids: string[]): Promise<Map<string, Marker[]>> {
  const out = new Map<string, Marker[]>();
  if (!ids.length) return out;
  const rows = await tx.auditEvent.findMany({ where: { entityType, entityId: { in: ids }, action }, select: { entityId: true, meta: true } });
  for (const r of rows) {
    const m = r.meta as { tier?: string; anchor?: string } | null;
    if (!r.entityId || !m?.tier) continue;
    out.set(r.entityId, [...(out.get(r.entityId) ?? []), { tier: m.tier, anchor: m.anchor ?? "" }]);
  }
  return out;
}

function sentTiers(list: Marker[] | undefined, anchor: string): Set<string> {
  return new Set((list ?? []).filter((m) => m.anchor === anchor).map((m) => m.tier));
}

interface Ctx {
  tx: Tx;
  sys: ServiceContext;
  dir: Directory;
  out: NoticeBatch;
  now: Date;
  stats: { tiers: number; events: number };
}

async function mark(c: Ctx, o: { entityType: string; entityId: string; action: string; projectId: string | null; tier: string; anchor: string; recipients: number; event?: { type: DomainEventType; payload: Record<string, unknown> } }) {
  await audit(c.tx, c.sys, { action: o.action, entityType: o.entityType, entityId: o.entityId, projectId: o.projectId, summary: o.tier, meta: { tier: o.tier, anchor: o.anchor, recipients: o.recipients } });
  if (o.event) {
    await emit(c.tx, c.sys, o.event.type, o.event.payload);
    c.stats.events++;
  }
  c.stats.tiers++;
}

// ── Tasks: L1 owner → L2 PMs → L3 directors ──────────────────────────────────

async function escalateTasks(c: Ctx) {
  const { tx, now } = c;
  // a re-planned task (due date moved into the future) starts again at L0
  await tx.task.updateMany({ where: { escalationLevel: { gt: 0 }, dueAt: { gt: now }, statusCategory: { notIn: ["DONE", "CANCELLED"] } }, data: { escalationLevel: 0, escalatedAt: null } });
  const tasks = await tx.task.findMany({
    where: {
      statusCategory: { notIn: ["DONE", "CANCELLED"] },
      dueAt: { lte: now },
      // finished ladders are re-checked only while recently changed (a re-plan or re-assignment)
      OR: [{ escalationLevel: { lt: 3 } }, { updatedAt: { gte: new Date(now.getTime() - 48 * H) } }],
      AND: [{ project: { status: { notIn: [...PAUSED] } } }, { OR: [{ project: { status: { not: "COMPLETED" } } }, { tags: { has: "closeout" } }] }],
    },
    select: { id: true, title: true, number: true, projectId: true, ownerId: true, dueAt: true, createdAt: true, escalationLevel: true, escalatedAt: true, project: { select: { code: true } }, owner: { select: { name: true, nameAr: true } } },
    orderBy: { dueAt: "asc" },
    take: BATCH.tasks,
  });
  if (!tasks.length) return;
  const ids = tasks.map((t) => t.id);
  const [history, marks] = await Promise.all([
    tx.taskAssignmentHistory.findMany({ where: { taskId: { in: ids } }, select: { taskId: true, createdAt: true } }),
    markers(tx, "TASK", "task.escalation", ids),
  ]);
  for (const t of tasks) {
    // re-assignment after the due date restarts the ladder from the hand-over (the new owner gets a fresh L1)
    // (the assignment written with the task itself is not a re-assignment: same transaction, a few ms later)
    const reassignedAt = history.filter((h) => h.taskId === t.id && h.createdAt.getTime() > t.createdAt.getTime() + CREATION_SLACK_MS).reduce<Date | null>((a, h) => (!a || h.createdAt > a ? h.createdAt : a), null);
    const anchorDate = reassignedAt && reassignedAt > t.dueAt! ? reassignedAt : t.dueAt!;
    const anchor = anchorDate.toISOString();
    const elapsed = now.getTime() - anchorDate.getTime();
    const ownerActive = await c.dir.isActive(t.ownerId);
    let target = elapsed >= TASK_LADDER_H.L3 * H ? 3 : elapsed >= TASK_LADDER_H.L2 * H ? 2 : 1;
    if (!ownerActive && target === 1) target = 2; // unowned (or owner left): skip to L2 now
    const sent = sentTiers(marks.get(t.id), anchor);
    const due = [1, 2, 3].filter((l) => l <= target && !sent.has(`L${l}`) && (l !== 1 || ownerActive));
    if (!due.length) continue;
    const code = `${t.project.code}-${t.number}`;
    const days = Math.max(0, Math.floor((now.getTime() - t.dueAt!.getTime()) / (24 * H)));
    const owner = t.owner ? (t.owner.nameAr ?? t.owner.name) : null;
    const level = Math.max(target, ...[...sent].map((x) => Number(x.slice(1)) || 0));
    await tx.task.updateMany({ where: { id: t.id }, data: { escalationLevel: level, ...(level >= 2 && !t.escalatedAt ? { escalatedAt: now } : {}) } });
    for (const l of due) {
      const recipients = l === 1 ? [t.ownerId!] : l === 2 ? await c.dir.pmsOrFallback(t.projectId) : await c.dir.directors();
      const key = `task.overdue:${t.id}:${anchor}:L${l}`;
      const type = l === 1 ? "task.overdue" : "task.escalated";
      c.out.add(recipients, {
        key,
        type,
        level: l,
        titleKey: l === 1 ? "notif.taskOverdue" : "notif.taskEscalated",
        params: { title: t.title, code, days, owner: owner ?? "—" },
        link: `/tasks/${t.id}`,
        entityType: "TASK",
        entityId: t.id,
        priority: l === 3 ? "HIGH" : "NORMAL",
        many: { titleKey: "notif.taskEscalatedMany", link: "/?f=tasks" },
      });
      await mark(c, {
        entityType: "TASK", entityId: t.id, action: "task.escalation", projectId: t.projectId, tier: `L${l}`, anchor, recipients: recipients.length,
        event: { type: l === 1 ? "task.overdue" : "task.escalated", payload: { taskId: t.id, projectId: t.projectId, ownerId: t.ownerId, title: t.title, code, level: l, link: `/tasks/${t.id}`, entityType: "TASK", entityId: t.id, dedupeKey: key } },
      });
    }
  }
}

/** Unowned tasks due within 3 days: one notice to the PMs per task and due date. */
async function unownedDueSoon(c: Ctx) {
  const { tx, now } = c;
  const tasks = await tx.task.findMany({
    where: { ownerId: null, parentId: null, statusCategory: { notIn: ["DONE", "CANCELLED"] }, dueAt: { gt: now, lte: new Date(now.getTime() + UNOWNED_DUE_WINDOW_H * H) }, project: { status: { notIn: [...QUIET] } } },
    select: { id: true, title: true, number: true, projectId: true, dueAt: true, project: { select: { code: true } } },
    take: BATCH.tasks,
  });
  const marks = await markers(tx, "TASK", "task.unowned_due", tasks.map((t) => t.id));
  for (const t of tasks) {
    const anchor = t.dueAt!.toISOString();
    if (sentTiers(marks.get(t.id), anchor).has("U")) continue;
    const recipients = await c.dir.pmsOrFallback(t.projectId);
    const code = `${t.project.code}-${t.number}`;
    c.out.add(recipients, { key: `task.unowned_due:${t.id}:${anchor}`, type: "task.unowned_due", level: 0, titleKey: "notif.taskUnownedDue", params: { title: t.title, code }, link: `/tasks/${t.id}`, entityType: "TASK", entityId: t.id, many: { titleKey: "notif.taskUnownedDueMany", link: "/?f=tasks" } });
    await mark(c, { entityType: "TASK", entityId: t.id, action: "task.unowned_due", projectId: t.projectId, tier: "U", anchor, recipients: recipients.length });
  }
}

// ── Approvals: reminder → L1 → L2 → L3 ──────────────────────────────────────

const FINANCIAL = new Set(["PURCHASE_ORDER", "EXPENSE", "CHANGE_ORDER"]);

async function escalateApprovals(c: Ctx, slaHours: number) {
  const { tx, now } = c;
  const horizon = new Date(now.getTime() + APPROVAL_REMINDER_BEFORE_DUE_H * H);
  const approvals = await tx.approval.findMany({
    where: { status: "PENDING", OR: [{ dueAt: { lte: horizon } }, { dueAt: null, createdAt: { lte: new Date(horizon.getTime() - slaHours * H) } }] },
    orderBy: { createdAt: "asc" },
    take: BATCH.approvals,
  });
  if (!approvals.length) return;
  const projects = await tx.project.findMany({ where: { id: { in: [...new Set(approvals.map((a) => a.projectId))] } } });
  const marks = await markers(tx, "APPROVAL", "approval.escalation", approvals.map((a) => a.id));
  for (const a of approvals) {
    const project = projects.find((p) => p.id === a.projectId);
    if (!project || (PAUSED as readonly string[]).includes(project.status)) continue; // ON_HOLD pauses the clock
    const dueAt = a.dueAt ?? new Date(a.createdAt.getTime() + slaHours * H);
    const sla = (dueAt.getTime() - a.createdAt.getTime()) / H;
    const t = now.getTime() - dueAt.getTime();
    const sent = sentTiers(marks.get(a.id), "");
    const reached = [
      ...(sla >= APPROVAL_REMINDER_MIN_SLA_H && t >= -APPROVAL_REMINDER_BEFORE_DUE_H * H ? ["R"] : []),
      ...(t >= 0 ? ["L1"] : []),
      ...(t >= 24 * H ? ["L2"] : []),
      ...(t >= 48 * H ? ["L3"] : []),
    ];
    // catching up after an outage: the reminder is pointless once the approval is already overdue
    const due = reached.filter((tier) => !sent.has(tier) && !(tier === "R" && reached.includes("L1")));
    if (!due.length) continue;
    const client = a.approverType === "CLIENT";
    const approverSet = async () => (await resolveApproverSet(tx, project, a)).notify;
    const link = a.entityType === "TASK" ? `/tasks/${a.entityId}` : `/projects/${a.projectId}/approvals`;
    const base = { params: { title: a.title }, link, entityType: "APPROVAL", entityId: a.id, many: { titleKey: "notif.approvalEscalatedMany", link: "/?f=decisions" } };
    for (const tier of due) {
      let recipients: string[] = [];
      if (tier === "R") {
        recipients = await approverSet();
        c.out.add(recipients, { ...base, key: `approval.reminder:${a.id}`, type: "approval.reminder", level: 0, titleKey: "notif.approvalReminder", many: { titleKey: "notif.approvalReminderMany", link: "/my-work" } });
      } else if (tier === "L1") {
        const approvers = await approverSet();
        recipients = [...approvers, a.requestedById];
        c.out.add(approvers, { ...base, key: `approval.overdue:${a.id}:L1`, type: "approval.overdue", level: 1, titleKey: "notif.approvalOverdue", many: { titleKey: "notif.approvalOverdueMany", link: "/my-work" } });
        c.out.add([a.requestedById], { ...base, key: `approval.overdue:${a.id}:L1:requester`, type: "approval.overdue", level: 1, titleKey: "notif.approvalOverdueRequester", many: { titleKey: "notif.approvalOverdueMany", link: "/my-work" } });
      } else if (tier === "L2") {
        const pms = await c.dir.pmsOrFallback(a.projectId);
        recipients = client ? [...pms, a.requestedById] : pms;
        c.out.add(recipients, { ...base, key: `approval.overdue:${a.id}:L2`, type: "approval.escalated", level: 2, titleKey: client ? "notif.approvalClientChase" : "notif.approvalEscalated" });
        if (client) {
          // one more reminder to the client approver set ("chase the client")
          const clients = await approverSet();
          recipients = [...recipients, ...clients];
          c.out.add(clients, { ...base, key: `approval.overdue:${a.id}:L2:client`, type: "approval.reminder", level: 0, titleKey: "notif.approvalReminder", many: { titleKey: "notif.approvalReminderMany", link: "/my-work" } });
        }
      } else {
        const directors = await c.dir.directors();
        const creator = FINANCIAL.has(a.entityType) ? await spendCreator(tx, a.entityType, a.entityId) : null;
        const finance = FINANCIAL.has(a.entityType) ? (await c.dir.financeApprovers()).filter((u) => u !== a.requestedById && u !== creator) : [];
        recipients = [...directors, ...finance];
        c.out.add(recipients, { ...base, key: `approval.overdue:${a.id}:L3`, type: "approval.escalated", level: 3, titleKey: "notif.approvalEscalated", priority: "HIGH" });
      }
      const type: DomainEventType = tier === "R" ? "approval.reminder" : tier === "L1" ? "approval.overdue" : "approval.escalated";
      await mark(c, {
        entityType: "APPROVAL", entityId: a.id, action: "approval.escalation", projectId: a.projectId, tier, anchor: "", recipients: new Set(recipients).size,
        event: { type, payload: { approvalId: a.id, projectId: a.projectId, tier, title: a.title, link, entityType: a.entityType, entityId: a.entityId, dedupeKey: `approval.overdue:${a.id}:${tier}` } },
      });
    }
  }
}

async function spendCreator(tx: Tx, entityType: string, entityId: string): Promise<string | null> {
  if (entityType === "PURCHASE_ORDER") return (await tx.purchaseOrder.findUnique({ where: { id: entityId }, select: { createdById: true } }))?.createdById ?? null;
  if (entityType === "EXPENSE") return (await tx.expense.findUnique({ where: { id: entityId }, select: { submittedById: true } }))?.submittedById ?? null;
  if (entityType === "CHANGE_ORDER") return (await tx.changeOrder.findUnique({ where: { id: entityId }, select: { createdById: true } }))?.createdById ?? null;
  return null;
}

// ── Vendor work orders (KD-1, QA [S3-3]) ─────────────────────────────────────

async function escalateWorkOrders(c: Ctx) {
  const { tx, now } = c;
  const wos = await tx.workOrder.findMany({
    where: { status: { in: ["ISSUED", "ACCEPTED", "IN_PROGRESS"] }, OR: [{ dueAt: { lte: now } }, { status: "ISSUED", createdAt: { lte: new Date(now.getTime() - WORK_ORDER_NOT_ACCEPTED_H * H) } }] },
    orderBy: { createdAt: "asc" },
    take: BATCH.workOrders,
  });
  if (!wos.length) return;
  const projects = await tx.project.findMany({ where: { id: { in: [...new Set(wos.map((w) => w.projectId))] } }, select: { id: true, status: true, code: true } });
  const marks = await markers(tx, "WORK_ORDER", "workorder.escalation", wos.map((w) => w.id));
  for (const w of wos) {
    const project = projects.find((p) => p.id === w.projectId);
    if (!project || (PAUSED as readonly string[]).includes(project.status)) continue; // COMPLETED keeps the work-order tail
    const link = `/projects/${w.projectId}/procurement`;
    const vendorSide = [...(await c.dir.vendorUsers(w.vendorId)), ...((await c.dir.isActive(w.createdById)) ? [w.createdById] : [])];
    const base = { params: { title: w.title, code: project.code }, link, entityType: "WORK_ORDER", entityId: w.id, many: { titleKey: "notif.workOrderEscalatedMany", link: `/vendors` } };
    // not accepted 48 h after issue (independent of the due date)
    const issueAnchor = w.createdAt.toISOString();
    if (w.status === "ISSUED" && now.getTime() - w.createdAt.getTime() >= WORK_ORDER_NOT_ACCEPTED_H * H && !sentTiers(marks.get(w.id), issueAnchor).has("NA")) {
      c.out.add(vendorSide, { ...base, key: `workorder.not_accepted:${w.id}`, type: "workorder.not_accepted", level: 0, titleKey: "notif.workOrderNotAccepted" });
      await mark(c, { entityType: "WORK_ORDER", entityId: w.id, action: "workorder.escalation", projectId: w.projectId, tier: "NA", anchor: issueAnchor, recipients: vendorSide.length, event: { type: "workorder.not_accepted", payload: { workOrderId: w.id, projectId: w.projectId, vendorId: w.vendorId, title: w.title, link } } });
    }
    if (!w.dueAt || w.dueAt > now) continue;
    const anchor = w.dueAt.toISOString();
    const elapsed = now.getTime() - w.dueAt.getTime();
    const sent = sentTiers(marks.get(w.id), anchor);
    const reached = ["L1", ...(elapsed >= WORK_ORDER_LADDER_H.L2 * H ? ["L2"] : []), ...(elapsed >= WORK_ORDER_LADDER_H.L3 * H ? ["L3"] : [])];
    for (const tier of reached.filter((x) => !sent.has(x))) {
      const level = Number(tier.slice(1));
      const recipients = level === 1 ? vendorSide : level === 2 ? await c.dir.pmsOrFallback(w.projectId) : await c.dir.directors();
      const key = `workorder.overdue:${w.id}:${anchor}:${tier}`;
      c.out.add(recipients, { ...base, key, type: level === 1 ? "workorder.overdue" : "workorder.escalated", level, titleKey: level === 1 ? "notif.workOrderOverdue" : "notif.workOrderEscalated", priority: level === 3 ? "HIGH" : "NORMAL" });
      await mark(c, {
        entityType: "WORK_ORDER", entityId: w.id, action: "workorder.escalation", projectId: w.projectId, tier, anchor, recipients: recipients.length,
        event: { type: level === 1 ? "workorder.overdue" : "workorder.escalated", payload: { workOrderId: w.id, projectId: w.projectId, vendorId: w.vendorId, title: w.title, level, link, entityType: "WORK_ORDER", entityId: w.id, dedupeKey: key } },
      });
    }
  }
}

// ── Incidents: unacknowledged by severity ────────────────────────────────────

async function escalateIncidents(c: Ctx) {
  const { tx, now } = c;
  const incidents = await tx.incident.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "asc" }, take: BATCH.incidents });
  if (!incidents.length) return;
  const ids = incidents.map((i) => i.id);
  const [projects, manual, marks] = await Promise.all([
    tx.project.findMany({ where: { id: { in: [...new Set(incidents.map((i) => i.projectId))] } }, select: { id: true, status: true } }),
    tx.auditEvent.findMany({ where: { entityType: "INCIDENT", entityId: { in: ids }, action: "incident.escalate" }, select: { entityId: true, createdAt: true } }),
    markers(tx, "INCIDENT", "incident.escalation", ids),
  ]);
  for (const i of incidents) {
    const project = projects.find((p) => p.id === i.projectId);
    if (!project || (QUIET as readonly string[]).includes(project.status)) continue;
    // a manual escalation raises severity and restarts the ladder from that moment
    const restartedAt = manual.filter((m) => m.entityId === i.id).reduce<Date | null>((a, m) => (!a || m.createdAt > a ? m.createdAt : a), null);
    const anchorDate = restartedAt ?? i.createdAt;
    const anchor = anchorDate.toISOString();
    const sent = sentTiers(marks.get(i.id), anchor);
    const link = `/projects/${i.projectId}/events`;
    const base = { params: { title: i.title }, link, entityType: "INCIDENT", entityId: i.id, many: { titleKey: "notif.incidentEscalatedMany", link: "/?f=events" } };
    // MEDIUM/LOW: the PMs get an in-app notice at report (HIGH/CRITICAL are announced by the incident rule)
    if ((i.severity === "MEDIUM" || i.severity === "LOW") && !restartedAt && !sent.has("R") && now.getTime() - i.createdAt.getTime() < 24 * H) {
      const pms = await c.dir.pmsOrFallback(i.projectId);
      c.out.add(pms, { ...base, key: `incident.reported:${i.id}`, type: "incident.reported", level: 0, titleKey: "notif.incidentReportedPm", priority: "NORMAL", many: { titleKey: "notif.incidentReportedMany", link: "/?f=events" } });
      await mark(c, { entityType: "INCIDENT", entityId: i.id, action: "incident.escalation", projectId: i.projectId, tier: "R", anchor, recipients: pms.length });
    }
    const windows = INCIDENT_ACK_MIN[i.severity] ?? [];
    const elapsedMin = (now.getTime() - anchorDate.getTime()) / MIN;
    for (const [idx, minutes] of windows.entries()) {
      const tier = `L${idx + 2}`;
      if (elapsedMin < minutes || sent.has(tier)) continue;
      let recipients: string[];
      if (i.severity === "CRITICAL") recipients = idx === 0 ? [...(await c.dir.directors()), ...(await c.dir.owners())] : await c.dir.owners();
      else if (i.severity === "HIGH") recipients = await c.dir.directors();
      else recipients = await c.dir.pmsOrFallback(i.projectId);
      const level = idx + 2;
      const key = `incident.escalated:${i.id}:${anchor}:${tier}`;
      const critical = i.severity === "CRITICAL";
      c.out.add(recipients, { ...base, key, type: "incident.escalated", level, titleKey: critical && idx === 1 ? "notif.incidentUnacknowledgedHour" : "notif.incidentEscalated", priority: critical ? "CRITICAL" : "HIGH" });
      // escalationLevel counts the tiers reached (ES-2: the first one sets 1); not user content → no version bump
      await tx.incident.updateMany({ where: { id: i.id, status: "OPEN" }, data: { escalationLevel: { increment: 1 } } });
      await mark(c, {
        entityType: "INCIDENT", entityId: i.id, action: "incident.escalation", projectId: i.projectId, tier, anchor, recipients: recipients.length,
        event: { type: "incident.escalated", payload: { incidentId: i.id, projectId: i.projectId, severity: i.severity, title: i.title, level, link, entityType: "INCIDENT", entityId: i.id, dedupeKey: key } },
      });
    }
  }
}

// ── Deliveries near the campaign deadline (consolidated per campaign) ────────

const UNDELIVERED = ["PENDING", "VALIDATING", "READY", "ASSIGNED", "OUT_FOR_DELIVERY", "FAILED_ATTEMPT", "RESCHEDULED"] as const;
const NOT_OUT = ["PENDING", "VALIDATING", "READY", "ASSIGNED", "FAILED_ATTEMPT", "RESCHEDULED"] as const;

async function deliveryDeadlines(c: Ctx) {
  const { tx, now } = c;
  const campaigns = await tx.invitationCampaign.findMany({
    where: { type: "PHYSICAL", deliveryDeadline: { not: null, lte: new Date(now.getTime() - DEADLINE_LADDER_H.T1 * H), gte: new Date(now.getTime() - 7 * 24 * H) }, status: { notIn: ["CANCELLED", "COMPLETED"] } },
    select: { id: true, name: true, projectId: true, deliveryDeadline: true },
    take: BATCH.campaigns,
  });
  if (!campaigns.length) return;
  const ids = campaigns.map((x) => x.id);
  const [projects, notOut, undelivered, marks] = await Promise.all([
    tx.project.findMany({ where: { id: { in: [...new Set(campaigns.map((x) => x.projectId))] } }, select: { id: true, status: true } }),
    tx.delivery.groupBy({ by: ["campaignId"], where: { campaignId: { in: ids }, status: { in: [...NOT_OUT] } }, _count: true }),
    tx.delivery.groupBy({ by: ["campaignId"], where: { campaignId: { in: ids }, status: { in: [...UNDELIVERED] } }, _count: true }),
    markers(tx, "CAMPAIGN", "campaign.deadline_escalation", ids),
  ]);
  for (const k of campaigns) {
    const project = projects.find((p) => p.id === k.projectId);
    if (!project || (QUIET as readonly string[]).includes(project.status)) continue;
    const deadline = k.deliveryDeadline!;
    const anchor = deadline.toISOString();
    const left = deadline.getTime() - now.getTime();
    const nNotOut = notOut.find((x) => x.campaignId === k.id)?._count ?? 0;
    const nUndelivered = undelivered.find((x) => x.campaignId === k.id)?._count ?? 0;
    const tier = left <= DEADLINE_LADDER_H.T3 * H ? (nUndelivered ? "T3" : null) : left <= -DEADLINE_LADDER_H.T2 * H ? (nNotOut ? "T2" : null) : nNotOut ? "T1" : null;
    if (!tier) continue;
    const sent = sentTiers(marks.get(k.id), anchor);
    if (sent.has(tier)) continue;
    const count = tier === "T3" ? nUndelivered : nNotOut;
    const recipients = tier === "T1" ? await c.dir.pmsOrFallback(k.projectId) : tier === "T2" ? [...(await c.dir.pmsOrFallback(k.projectId)), ...(await c.dir.directors())] : await c.dir.directors();
    const key = `delivery.deadline:${k.id}:${anchor}:${tier}`;
    const link = `/projects/${k.projectId}/delivery`;
    c.out.add(recipients, { key, type: "delivery.deadline_risk", level: tier === "T1" ? 1 : tier === "T2" ? 2 : 3, titleKey: `notif.deliveryDeadline${tier}`, params: { title: k.name, count }, link, entityType: "CAMPAIGN", entityId: k.id, priority: tier === "T3" ? "HIGH" : "NORMAL", many: { titleKey: "notif.deliveryDeadlineMany", link: "/?f=delivery" } });
    // a later tier reached first (scheduler outage) also marks the earlier ones, so they never fire late
    for (const t of tier === "T3" ? ["T1", "T2", "T3"] : tier === "T2" ? ["T1", "T2"] : ["T1"]) {
      if (sent.has(t)) continue;
      await mark(c, {
        entityType: "CAMPAIGN", entityId: k.id, action: "campaign.deadline_escalation", projectId: k.projectId, tier: t, anchor, recipients: t === tier ? recipients.length : 0,
        event: t === tier ? { type: "delivery.deadline_risk", payload: { campaignId: k.id, projectId: k.projectId, tier, count, title: k.name, link, dedupeKey: key } } : undefined,
      });
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export interface EscalationResult {
  tiers: number;
  events: number;
  notices: number;
}

/** Runs every ladder for one organisation inside the scheduler's tenant transaction. */
export async function runEscalations(tx: Tx, sys: ServiceContext, now: Date, settings: Prisma.JsonValue): Promise<EscalationResult> {
  const c: Ctx = { tx, sys, dir: new Directory(tx), out: new NoticeBatch(), now, stats: { tiers: 0, events: 0 } };
  const s = (settings ?? {}) as { approvalSlaHours?: unknown };
  const sla = typeof s.approvalSlaHours === "number" && s.approvalSlaHours >= 4 && s.approvalSlaHours <= 168 ? s.approvalSlaHours : APPROVAL_SLA_HOURS_DEFAULT;
  await escalateTasks(c);
  await unownedDueSoon(c);
  await escalateApprovals(c, sla);
  await escalateWorkOrders(c);
  await escalateIncidents(c);
  await deliveryDeadlines(c);
  const notices = await c.out.flush(tx, sys.orgId);
  return { ...c.stats, notices };
}
