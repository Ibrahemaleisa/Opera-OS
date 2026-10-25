import type { Tx } from "@/server/db/tenant";
import { loadFinanceSummaries } from "@/server/modules/finance/forecast";
import {
  DAY_MS,
  PRIORITY_WEIGHT,
  approvalDueAt,
  openIncidentWhere,
  overdueMilestoneWhere,
  overdueTaskWhere,
  readinessAtRisk,
  readinessEventWhere,
  unownedForHealthWhere,
} from "@/server/modules/operations/criteria";

export interface HealthInput {
  totalTasks: number;
  doneTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  openHighRisks: number;
  blockedMilestones: number;
  overdueMilestones: number;
  /** 0..1 elapsed share of schedule (start → deadline) */
  elapsed: number | null;
  /** actual / planned budget, null if unknown */
  budgetRatio: number | null;
}

/**
 * Health score 0–100 computed from live records. Transparent weighting:
 * overdue work, blocked work, schedule slip (elapsed vs. done), high risks,
 * blocked/overdue milestones and budget overrun each subtract points.
 */
export function computeHealth(h: HealthInput): { score: number; level: "good" | "watch" | "critical"; factors: Record<string, number> } {
  const factors: Record<string, number> = {};
  if (h.totalTasks > 0) {
    factors.overdue = Math.min(30, Math.round((h.overdueTasks / h.totalTasks) * 60));
    factors.blocked = Math.min(15, h.blockedTasks * 3);
    if (h.elapsed !== null) {
      const progress = h.doneTasks / h.totalTasks;
      const slip = Math.max(0, h.elapsed - progress);
      factors.schedule = Math.min(20, Math.round(slip * 40));
    }
  }
  factors.risks = Math.min(15, h.openHighRisks * 5);
  factors.milestones = Math.min(15, h.blockedMilestones * 5 + h.overdueMilestones * 4);
  if (h.budgetRatio !== null && h.budgetRatio > 1) factors.budget = Math.min(15, Math.round((h.budgetRatio - 1) * 50));
  const score = Math.max(0, 100 - Object.values(factors).reduce((a, b) => a + b, 0));
  return { score, level: score >= 75 ? "good" : score >= 50 ? "watch" : "critical", factors };
}

// ── Health v2 ──────────────────────────────────────────────────────────────
//
// One computation for the portfolio, the project overview and the operations board. The pure
// function scores structured inputs; `loadProjectHealth` computes those inputs for many projects
// with batched queries built from the shared operations criteria, so every surface agrees.


export type HealthLevel = "good" | "watch" | "critical";

export const HEALTH_REASON_KEYS = ["schedule", "overdue", "unowned", "approvalsOverdue", "clientDelay", "milestones", "readiness", "overContract", "overPlan", "incidents", "blocked", "risks"] as const;
export type HealthReasonKey = (typeof HEALTH_REASON_KEYS)[number];

export interface HealthReason {
  key: HealthReasonKey;
  /** points subtracted from 100 (0 for reasons shown but not blamed on the agency) */
  points: number;
  /** how many items are behind the reason (tasks, approvals, events, budget lines…) */
  count: number;
  /** finance reason: render without amounts for viewers without finance scope */
  finance?: boolean;
  /** a blocker marks the project at risk regardless of the score */
  blocker?: boolean;
}

export interface ProjectHealth {
  score: number;
  level: HealthLevel;
  atRisk: boolean;
  /** worst first */
  reasons: HealthReason[];
  /** key → points, for callers written against v1 */
  factors: Record<string, number>;
  /** share of tasks whose due date has passed (null without dated tasks) vs share done */
  schedule: { expected: number | null; actual: number; daysToAnchor: number | null; anchor: "event" | "deadline" | null };
  /** top-level tasks done / total (cancelled excluded) */
  progress: { done: number; total: number };
}

export interface HealthV2Input {
  now: Date;
  /** eventStartAt, falling back to the deadline */
  eventStartAt: Date | null;
  deadline: Date | null;
  tasks: {
    /** open + done top-level tasks (cancelled excluded) */
    total: number;
    done: number;
    /** tasks (any status but cancelled) whose due date has passed */
    duePassed: number;
    blocked: number;
    overdue: { priority: string; clientVisible: boolean; count: number }[];
    unownedDueSoon: number;
  };
  approvals: { internalOverdue: number; clientOverdue: number };
  milestones: { overdue: number; blocked: number };
  /** events within the readiness window whose readiness is below threshold or has issues */
  readinessEventsAtRisk: number;
  incidents: { high: number; critical: number };
  highRisks: number;
  finance: { overPlanLines: number; overContract: boolean } | null;
}

const cap = (max: number, v: number) => Math.min(max, Math.max(0, Math.round(v)));

export function computeHealthV2(h: HealthV2Input): ProjectHealth {
  const reasons: HealthReason[] = [];
  const add = ({ blocker, ...r }: HealthReason) => {
    if (r.count > 0) reasons.push(blocker ? { ...r, blocker } : r);
  };
  const anchorDate = h.eventStartAt ?? h.deadline;
  const daysToAnchor = anchorDate ? Math.ceil((anchorDate.getTime() - h.now.getTime()) / DAY_MS) : null;
  const t = h.tasks;

  // schedule: share of work that should be done by now (due date passed) vs share done.
  // The closer the event, the more a slip costs.
  const expected = t.total > 0 ? t.duePassed / t.total : null;
  const actual = t.total > 0 ? t.done / t.total : 0;
  if (expected !== null) {
    const slip = Math.max(0, expected - actual);
    const urgency = daysToAnchor === null ? 1 : daysToAnchor <= 7 ? 2 : daysToAnchor <= 21 ? 1.5 : 1;
    add({ key: "schedule", points: cap(25, slip * 50 * urgency), count: Math.max(0, t.duePassed - t.done) });
  }

  // overdue work, weighted: high/critical priority and client-visible items count more
  const overdueCount = t.overdue.reduce((a, o) => a + o.count, 0);
  const weighted = t.overdue.reduce((a, o) => a + o.count * ((PRIORITY_WEIGHT[o.priority] ?? 1) + (o.clientVisible ? 1 : 0)), 0);
  const overdueCritical = t.overdue.filter((o) => o.priority === "CRITICAL").reduce((a, o) => a + o.count, 0);
  add({ key: "overdue", points: cap(30, weighted * 3), count: overdueCount, blocker: overdueCritical > 0 });

  add({ key: "unowned", points: cap(15, t.unownedDueSoon * 3), count: t.unownedDueSoon });
  add({ key: "approvalsOverdue", points: cap(10, h.approvals.internalOverdue * 4), count: h.approvals.internalOverdue });
  // the client owes these: shown, never blamed on the agency
  add({ key: "clientDelay", points: 0, count: h.approvals.clientOverdue });
  add({ key: "milestones", points: cap(15, (h.milestones.overdue + h.milestones.blocked) * 5), count: h.milestones.overdue + h.milestones.blocked });
  add({ key: "readiness", points: cap(20, h.readinessEventsAtRisk * 10), count: h.readinessEventsAtRisk, blocker: true });
  if (h.finance?.overContract) add({ key: "overContract", points: 15, count: 1, finance: true, blocker: true });
  else if (h.finance && h.finance.overPlanLines > 0) add({ key: "overPlan", points: cap(15, 5 * h.finance.overPlanLines), count: h.finance.overPlanLines, finance: true });
  const incidents = h.incidents.high + h.incidents.critical;
  add({ key: "incidents", points: cap(20, incidents * 10), count: incidents, blocker: h.incidents.critical > 0 });
  add({ key: "blocked", points: cap(10, t.blocked * 2), count: t.blocked });
  add({ key: "risks", points: cap(10, h.highRisks * 5), count: h.highRisks });

  reasons.sort((a, b) => b.points - a.points || HEALTH_REASON_KEYS.indexOf(a.key) - HEALTH_REASON_KEYS.indexOf(b.key));
  const score = Math.max(0, 100 - reasons.reduce((a, r) => a + r.points, 0));
  const hasBlocker = reasons.some((r) => r.blocker);
  let level: HealthLevel = score >= 75 ? "good" : score >= 50 ? "watch" : "critical";
  if (hasBlocker && level === "good") level = "watch";
  return {
    score,
    level,
    atRisk: score < 60 || hasBlocker,
    reasons,
    factors: Object.fromEntries(reasons.map((r) => [r.key, r.points])),
    schedule: { expected, actual, daysToAnchor, anchor: h.eventStartAt ? "event" : h.deadline ? "deadline" : null },
    progress: { done: t.done, total: t.total },
  };
}

/** Health v2 for many projects, computed from live records inside a tenant transaction. */
export async function loadProjectHealth(tx: Tx, projectIds: string[], now = new Date()): Promise<Map<string, ProjectHealth>> {
  const out = new Map<string, ProjectHealth>();
  if (!projectIds.length) return out;
  const ids = projectIds;
  const [projects, byCat, duePassed, overdue, unowned, approvals, milestonesOverdue, milestonesBlocked, events, incidents, risks, finance] = await Promise.all([
    tx.project.findMany({ where: { id: { in: ids } }, select: { id: true, eventStartAt: true, deadline: true } }),
    tx.task.groupBy({ by: ["projectId", "statusCategory"], where: { projectId: { in: ids }, parentId: null }, _count: true }),
    tx.task.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, parentId: null, statusCategory: { not: "CANCELLED" }, dueAt: { lt: now } }, _count: true }),
    tx.task.groupBy({ by: ["projectId", "priority", "clientVisible"], where: overdueTaskWhere(ids, now), _count: true }),
    tx.task.groupBy({ by: ["projectId"], where: unownedForHealthWhere(ids, now), _count: true }),
    tx.approval.findMany({ where: { projectId: { in: ids }, status: "PENDING" }, select: { projectId: true, approverType: true, dueAt: true, createdAt: true } }),
    tx.milestone.groupBy({ by: ["projectId"], where: overdueMilestoneWhere(ids, now), _count: true }),
    tx.milestone.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, status: "BLOCKED", OR: [{ dueDate: null }, { dueDate: { gte: now } }] }, _count: true }),
    tx.event.findMany({ where: readinessEventWhere(ids, now), select: { id: true, projectId: true } }),
    tx.incident.groupBy({ by: ["projectId", "severity"], where: { ...openIncidentWhere(ids), severity: { in: ["HIGH", "CRITICAL"] } }, _count: true }),
    tx.risk.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, status: { not: "CLOSED" }, likelihood: { gte: 3 }, impact: { gte: 3 } }, _count: true }),
    loadFinanceSummaries(tx, ids),
  ]);
  const readiness = events.length
    ? await tx.readinessItem.groupBy({ by: ["eventId", "status"], where: { eventId: { in: events.map((e) => e.id) } }, _count: true })
    : [];
  const count = <T extends { projectId: string; _count: number }>(rows: T[], pid: string) => rows.filter((r) => r.projectId === pid).reduce((a, r) => a + r._count, 0);
  for (const p of projects) {
    const cats = byCat.filter((c) => c.projectId === p.id);
    const fin = finance.find((f) => f.projectId === p.id);
    const evs = events.filter((e) => e.projectId === p.id).map((e) => {
      const rs = readiness.filter((r) => r.eventId === e.id);
      return { total: rs.reduce((a, r) => a + r._count, 0), ready: rs.filter((r) => r.status === "READY").reduce((a, r) => a + r._count, 0), issues: rs.filter((r) => r.status === "ISSUE").reduce((a, r) => a + r._count, 0) };
    });
    const late = approvals.filter((a) => a.projectId === p.id && approvalDueAt(a) < now);
    out.set(
      p.id,
      computeHealthV2({
        now,
        eventStartAt: p.eventStartAt,
        deadline: p.deadline,
        tasks: {
          total: cats.filter((c) => c.statusCategory !== "CANCELLED").reduce((a, c) => a + c._count, 0),
          done: cats.filter((c) => c.statusCategory === "DONE").reduce((a, c) => a + c._count, 0),
          duePassed: count(duePassed, p.id),
          blocked: cats.filter((c) => c.statusCategory === "BLOCKED").reduce((a, c) => a + c._count, 0),
          overdue: overdue.filter((o) => o.projectId === p.id).map((o) => ({ priority: o.priority, clientVisible: o.clientVisible, count: o._count })),
          unownedDueSoon: count(unowned, p.id),
        },
        approvals: { internalOverdue: late.filter((a) => a.approverType !== "CLIENT").length, clientOverdue: late.filter((a) => a.approverType === "CLIENT").length },
        milestones: { overdue: count(milestonesOverdue, p.id), blocked: count(milestonesBlocked, p.id) },
        readinessEventsAtRisk: evs.filter(readinessAtRisk).length,
        incidents: {
          high: incidents.filter((i) => i.projectId === p.id && i.severity === "HIGH").reduce((a, i) => a + i._count, 0),
          critical: incidents.filter((i) => i.projectId === p.id && i.severity === "CRITICAL").reduce((a, i) => a + i._count, 0),
        },
        highRisks: count(risks, p.id),
        finance: fin ? { overPlanLines: fin.lines.filter((l) => l.overBudget).length, overContract: fin.overContract } : null,
      }),
    );
  }
  return out;
}
