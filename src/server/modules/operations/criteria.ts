import type { Prisma } from "@/generated/prisma/client";

/**
 * The definitions behind every "late / missing / waiting" signal. The health score, the
 * operations board and My work all build their queries from these fragments, so a count
 * on one surface always matches the list on another.
 */

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** Projects that are archived or paused never raise operational exceptions. */
export const EXCLUDED_PROJECT_STATUSES = ["CLOSED", "CANCELLED", "COMPLETED", "ON_HOLD"] as const;
export const OPEN_TASK_CATEGORIES = { notIn: ["DONE", "CANCELLED"] } as { notIn: ("DONE" | "CANCELLED")[] };
export const OPEN_INCIDENT_STATUSES = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] as const;
/** Deliveries that have not left yet (failed attempts are counted separately). */
export const NOT_OUT_DELIVERY_STATUSES = ["PENDING", "VALIDATING", "READY", "ASSIGNED", "RESCHEDULED"] as const;

/** Unowned work shows on the board this far ahead; within URGENT it is highlighted. */
export const UNOWNED_HORIZON_DAYS = 14;
export const UNOWNED_URGENT_DAYS = 3;
/** Health counts unowned work due within this window (overdue included). */
export const HEALTH_UNOWNED_DAYS = 7;
/** Events this close are checked for readiness. */
export const EVENT_READINESS_DAYS = 7;
export const READINESS_THRESHOLD = 0.8;
/** Deliveries not out this close to the campaign deadline are an exception. */
export const DELIVERY_DEADLINE_HOURS = 48;
/** An approval without its own due date is due this long after the request (P1 default). */
export const APPROVAL_DEFAULT_SLA_HOURS = 48;
/** A CRITICAL incident still OPEN after this long goes to the top of the board. */
export const CRITICAL_UNACKED_MINUTES = 15;

export const activeProjectWhere: Prisma.ProjectWhereInput = { archivedAt: null, status: { notIn: [...EXCLUDED_PROJECT_STATUSES] } };

/** Top-level tasks only: subtasks roll up into their parent and are never counted twice. */
export const topLevelOpenTask = (projectIds: string[]): Prisma.TaskWhereInput => ({ projectId: { in: projectIds }, parentId: null, statusCategory: OPEN_TASK_CATEGORIES });

export const overdueTaskWhere = (projectIds: string[], now: Date): Prisma.TaskWhereInput => ({ ...topLevelOpenTask(projectIds), dueAt: { lt: now } });

/** Not yet overdue, no owner, due inside the horizon. */
export const unownedSoonTaskWhere = (projectIds: string[], now: Date, days = UNOWNED_HORIZON_DAYS): Prisma.TaskWhereInput => ({
  ...topLevelOpenTask(projectIds),
  ownerId: null,
  dueAt: { gte: now, lte: new Date(now.getTime() + days * DAY_MS) },
});

/** Health variant: unowned and due within the window, overdue included. */
export const unownedForHealthWhere = (projectIds: string[], now: Date): Prisma.TaskWhereInput => ({
  ...topLevelOpenTask(projectIds),
  ownerId: null,
  dueAt: { lte: new Date(now.getTime() + HEALTH_UNOWNED_DAYS * DAY_MS) },
});

/** Open task waiting on a predecessor that is itself open and past due. */
export const blockedByLateDependencyWhere = (projectIds: string[], now: Date): Prisma.TaskDependencyWhereInput => ({
  task: topLevelOpenTask(projectIds),
  dependsOn: { statusCategory: OPEN_TASK_CATEGORIES, dueAt: { lt: now } },
});

/** PENDING approval past its due date (or the default SLA when it has none). */
export const overdueApprovalWhere = (projectIds: string[], now: Date): Prisma.ApprovalWhereInput => ({
  projectId: { in: projectIds },
  status: "PENDING",
  OR: [{ dueAt: { lt: now } }, { dueAt: null, createdAt: { lt: new Date(now.getTime() - APPROVAL_DEFAULT_SLA_HOURS * HOUR_MS) } }],
});

export const approvalDueAt = (a: { dueAt: Date | null; createdAt: Date }) => a.dueAt ?? new Date(a.createdAt.getTime() + APPROVAL_DEFAULT_SLA_HOURS * HOUR_MS);

export const overdueMilestoneWhere = (projectIds: string[], now: Date): Prisma.MilestoneWhereInput => ({ projectId: { in: projectIds }, status: { not: "DONE" }, dueDate: { lt: now } });

export const openIncidentWhere = (projectIds: string[]): Prisma.IncidentWhereInput => ({ projectId: { in: projectIds }, status: { in: [...OPEN_INCIDENT_STATUSES] } });

/** Events whose readiness matters now: live, under way, or starting within the window. */
export const readinessEventWhere = (projectIds: string[], now: Date): Prisma.EventWhereInput => ({
  projectId: { in: projectIds },
  phase: { not: "CLOSED" },
  OR: [{ phase: "LIVE" }, { startsAt: { lte: new Date(now.getTime() + EVENT_READINESS_DAYS * DAY_MS) }, endsAt: { gte: now } }],
});

/** Readiness below the threshold, any ISSUE item, or no checklist at all. */
export function readinessAtRisk(r: { total: number; ready: number; issues: number }) {
  return r.total === 0 || r.issues > 0 || r.ready / r.total < READINESS_THRESHOLD;
}

export const PRIORITY_WEIGHT: Record<string, number> = { LOW: 1, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
export const SEVERITY_RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
