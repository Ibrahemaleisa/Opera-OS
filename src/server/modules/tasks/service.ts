import { z } from "zod";
import type { Prisma, StatusCategory, Task } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { projectScope, taskVisibilityWhere, type ProjectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { cancelPendingApprovalsTx, INACTIVE_PROJECT_STATUSES, mayDecide, resolveApproverSet, supersedeApprovalsTx } from "@/server/modules/approvals/service";
import { emit } from "@/server/modules/automation/outbox";
import { DEFAULT_STATUSES, type StatusDef } from "@/server/modules/templates/definition";
import { nextTaskNumber } from "./numbering";

const optDate = z.coerce.date().optional().nullable();

export const taskInput = z.object({
  projectId: z.string(),
  workstreamId: z.string().optional().nullable(),
  parentId: z.string().optional().nullable(),
  title: z.string().trim().min(2).max(300),
  description: z.string().trim().max(10000).optional().nullable(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  ownerId: z.string().optional().nullable(),
  startAt: optDate,
  dueAt: optDate,
  slaHours: z.coerce.number().int().positive().optional().nullable(),
  estimateMinutes: z.coerce.number().int().min(0).optional().nullable(),
  requiresApproval: z.boolean().default(false),
  clientVisible: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  recurrence: z.object({ freq: z.enum(["DAILY", "WEEKLY", "MONTHLY"]), interval: z.number().int().min(1).max(12).default(1), until: optDate }).optional().nullable(),
});

export const taskPatch = taskInput.omit({ projectId: true, parentId: true }).partial().extend({
  id: z.string(),
  version: z.number().int().optional(),
  actualMinutes: z.coerce.number().int().min(0).optional().nullable(),
});

export function statusesOf(ws: { statuses: unknown } | null | undefined): StatusDef[] {
  const s = ws?.statuses as StatusDef[] | undefined;
  return Array.isArray(s) && s.length ? s : DEFAULT_STATUSES;
}

async function loadTask(tx: Tx, ctx: ServiceContext, taskId: string) {
  const task = await tx.task.findUnique({ where: { id: taskId }, include: { workstream: true, collaborators: true } });
  if (!task) throw new NotFoundError();
  const scope = await projectScope(tx, ctx, task.projectId);
  assertTaskVisible(ctx, scope, task);
  return { task, scope };
}

function assertTaskVisible(ctx: ServiceContext, scope: ProjectScope, task: Task & { collaborators: { userId: string }[] }) {
  if (scope.fieldOnly) throw new NotFoundError();
  if (scope.clientView && !task.clientVisible) throw new NotFoundError();
  if (scope.taskScope === "assigned" && !scope.clientView && task.ownerId !== ctx.userId && !task.collaborators.some((c) => c.userId === ctx.userId)) throw new NotFoundError();
  if (scope.workstreamIds.length && task.workstreamId && !scope.workstreamIds.includes(task.workstreamId)) throw new NotFoundError();
}

function canEditTask(ctx: ServiceContext, scope: ProjectScope, task: Task) {
  if (scope.clientView) return false;
  if (scope.manage) return true;
  if (scope.taskScope === "assigned") return task.ownerId === ctx.userId;
  return scope.operate;
}

async function assertAssignable(tx: Tx, projectId: string, userId: string | null | undefined) {
  if (!userId) return;
  const pm = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { organizationId: true } });
  const m = await tx.membership.findFirst({ where: { organizationId: project.organizationId, userId, status: "ACTIVE" }, include: { role: true } });
  if (!m) throw new ValidationError("errors.validation", { ownerId: ["errors.notFound"] });
  // External roles (clients/vendors) and drivers must be on the project to receive work.
  if (["CLIENT", "CLIENT_APPROVER", "VENDOR", "FIELD_AGENT", "FREELANCER"].includes(m.role.baseRole) && !pm) throw new ValidationError("errors.validation", { ownerId: ["errors.forbidden"] });
}

export async function createTask(ctx: ServiceContext, input: z.output<typeof taskInput>) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.operate || scope.clientView || (scope.taskScope === "assigned" && !scope.manage && !input.parentId)) throw new ForbiddenError();
    let workstream = input.workstreamId ? await tx.workstream.findFirst({ where: { id: input.workstreamId, projectId: input.projectId } }) : null;
    if (input.workstreamId && !workstream) throw new NotFoundError();
    if (input.parentId) {
      const parent = await tx.task.findFirst({ where: { id: input.parentId, projectId: input.projectId } });
      if (!parent) throw new NotFoundError();
      workstream ??= parent.workstreamId ? await tx.workstream.findUnique({ where: { id: parent.workstreamId } }) : null;
    }
    await assertAssignable(tx, input.projectId, input.ownerId);
    const first = statusesOf(workstream).find((s) => s.category === "TODO") ?? statusesOf(workstream)[0];
    const number = await nextTaskNumber(tx, input.projectId);
    const { recurrence, ...rest } = input;
    const task = await tx.task.create({
      data: { ...rest, workstreamId: workstream?.id ?? null, recurrence: recurrence ? (recurrence as Prisma.InputJsonValue) : undefined, organizationId: ctx.orgId, number, status: first.key, statusCategory: first.category, createdById: ctx.userId },
    });
    await audit(tx, ctx, { action: "task.create", entityType: "TASK", entityId: task.id, projectId: task.projectId, summary: `#${number} ${task.title}` });
    if (task.ownerId) {
      await tx.taskAssignmentHistory.create({ data: { organizationId: ctx.orgId, taskId: task.id, toUserId: task.ownerId, changedById: ctx.userId } });
      await emit(tx, ctx, "task.assigned", { taskId: task.id, projectId: task.projectId, ownerId: task.ownerId, title: task.title, link: `/tasks/${task.id}`, entityType: "TASK", entityId: task.id });
    }
    return task;
  });
}

export async function updateTask(ctx: ServiceContext, patch: z.output<typeof taskPatch>) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { task, scope } = await loadTask(tx, ctx, patch.id);
    if (!canEditTask(ctx, scope, task)) throw new ForbiddenError();
    const { id, version, recurrence, ...data } = patch;
    // removing an approval gate or exposing a task to the client is a project-manager decision
    const gateChange = (data.requiresApproval !== undefined && data.requiresApproval !== task.requiresApproval) || (data.clientVisible !== undefined && data.clientVisible !== task.clientVisible);
    if (gateChange && !scope.manage) throw new ForbiddenError();
    if (data.ownerId !== undefined && data.ownerId !== task.ownerId) {
      if (!scope.manage && !scope.operate) throw new ForbiddenError();
      await assertAssignable(tx, task.projectId, data.ownerId);
    }
    if (data.workstreamId && !(await tx.workstream.findFirst({ where: { id: data.workstreamId, projectId: task.projectId } }))) throw new NotFoundError();
    // optimistic concurrency: reject stale edits
    const res = await tx.task.updateMany({
      where: { id, ...(version !== undefined ? { version } : {}) },
      data: { ...data, ...(recurrence !== undefined ? { recurrence: recurrence ? (recurrence as Prisma.InputJsonValue) : undefined } : {}), version: { increment: 1 } },
    });
    if (res.count === 0) throw new ConflictError();
    const updated = await tx.task.findUniqueOrThrow({ where: { id } });
    if (data.ownerId !== undefined && data.ownerId !== task.ownerId) {
      await tx.taskAssignmentHistory.create({ data: { organizationId: ctx.orgId, taskId: id, fromUserId: task.ownerId, toUserId: data.ownerId ?? null, changedById: ctx.userId } });
      if (data.ownerId) await emit(tx, ctx, "task.assigned", { taskId: id, projectId: task.projectId, ownerId: data.ownerId, title: updated.title, link: `/tasks/${id}`, entityType: "TASK", entityId: id });
    }
    const changed = Object.keys(data).filter((k) => JSON.stringify((task as Record<string, unknown>)[k]) !== JSON.stringify((updated as Record<string, unknown>)[k]));
    await audit(tx, ctx, { action: "task.update", entityType: "TASK", entityId: id, projectId: task.projectId, summary: changed.join(", "), before: Object.fromEntries(changed.map((k) => [k, (task as Record<string, unknown>)[k]])), after: Object.fromEntries(changed.map((k) => [k, (updated as Record<string, unknown>)[k]])) });
    return updated;
  });
}

/**
 * Status change with workflow rules:
 *  - target status must exist in the workstream workflow
 *  - moving to ACTIVE/REVIEW/DONE requires all dependencies DONE
 *  - tasks requiring approval can only reach DONE with an APPROVED approval
 *  - completing a recurring task schedules the next occurrence
 */
export async function changeTaskStatus(ctx: ServiceContext, input: { id: string; status: string; version?: number; reason?: string | null }) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { task, scope } = await loadTask(tx, ctx, input.id);
    if (!canEditTask(ctx, scope, task) && task.ownerId !== ctx.userId) throw new ForbiddenError();
    const statuses = statusesOf(task.workstream);
    const target = statuses.find((s) => s.key === input.status);
    if (!target) throw new ValidationError("errors.invalidTransition");
    if (target.key === task.status) return task;
    if (["ACTIVE", "REVIEW", "DONE"].includes(target.category)) {
      const deps = await tx.taskDependency.findMany({ where: { taskId: task.id }, include: { dependsOn: { select: { statusCategory: true, title: true } } } });
      const open = deps.filter((d) => !["DONE", "CANCELLED"].includes(d.dependsOn.statusCategory));
      if (open.length) throw new ValidationError("errors.blockedByDependencies", { status: open.map((d) => d.dependsOn.title) });
    }
    if (target.category === "DONE" && task.requiresApproval) {
      // the latest approval must be APPROVED and still valid (reopening supersedes it)
      const latest = await tx.approval.findFirst({ where: { entityType: "TASK", entityId: task.id, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" } });
      if (latest?.status !== "APPROVED") throw new ValidationError("errors.approvalRequired");
    }
    const res = await tx.task.updateMany({
      where: { id: task.id, ...(input.version !== undefined ? { version: input.version } : {}) },
      data: {
        status: target.key,
        statusCategory: target.category as StatusCategory,
        completedAt: target.category === "DONE" ? new Date() : null,
        blockedReason: target.category === "BLOCKED" ? input.reason ?? null : null,
        version: { increment: 1 },
      },
    });
    if (!res.count) throw new ConflictError();
    await audit(tx, ctx, { action: "task.status", entityType: "TASK", entityId: task.id, projectId: task.projectId, before: { status: task.status }, after: { status: target.key }, summary: input.reason ?? undefined });
    // reopening approved work invalidates its approval; cancelling work closes its open requests
    if (task.statusCategory === "DONE" && target.category !== "DONE") await supersedeApprovalsTx(tx, ctx, "TASK", task.id, input.reason?.trim() || "task reopened");
    if (target.category === "CANCELLED") await cancelPendingApprovalsTx(tx, ctx, { entityType: "TASK", entityId: task.id }, { reason: input.reason?.trim() || "task cancelled" });
    await emit(tx, ctx, "task.status_changed", { taskId: task.id, projectId: task.projectId, from: task.status, to: target.key, category: target.category, ownerId: task.ownerId, title: task.title });
    if (target.category === "DONE" && task.recurrence) await scheduleNextOccurrence(tx, ctx, task);
    return tx.task.findUniqueOrThrow({ where: { id: task.id } });
  });
}

export function nextOccurrence(from: Date, rule: { freq: "DAILY" | "WEEKLY" | "MONTHLY"; interval?: number }): Date {
  const d = new Date(from);
  const n = rule.interval ?? 1;
  if (rule.freq === "DAILY") d.setUTCDate(d.getUTCDate() + n);
  else if (rule.freq === "WEEKLY") d.setUTCDate(d.getUTCDate() + 7 * n);
  else d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}

async function scheduleNextOccurrence(tx: Tx, ctx: ServiceContext, task: Task & { workstream: { statuses: unknown } | null }) {
  const rule = task.recurrence as { freq: "DAILY" | "WEEKLY" | "MONTHLY"; interval?: number; until?: string | null };
  const base = task.dueAt ?? new Date();
  const due = nextOccurrence(base, rule);
  if (rule.until && due > new Date(rule.until)) return;
  const rootId = task.recurrenceParentId ?? task.id;
  // idempotency: one successor per (series, due date)
  const exists = await tx.task.findFirst({ where: { recurrenceParentId: rootId, dueAt: due } });
  if (exists) return;
  const first = statusesOf(task.workstream).find((s) => s.category === "TODO") ?? statusesOf(task.workstream)[0];
  const number = await nextTaskNumber(tx, task.projectId);
  await tx.task.create({
    data: {
      organizationId: ctx.orgId, projectId: task.projectId, workstreamId: task.workstreamId, number, title: task.title, description: task.description, priority: task.priority, ownerId: task.ownerId,
      startAt: task.startAt ? nextOccurrence(task.startAt, rule) : null, dueAt: due, slaHours: task.slaHours, estimateMinutes: task.estimateMinutes, requiresApproval: task.requiresApproval,
      clientVisible: task.clientVisible, tags: task.tags, recurrence: task.recurrence as Prisma.InputJsonValue, recurrenceParentId: rootId, status: first.key, statusCategory: first.category, createdById: ctx.userId,
    },
  });
}

export async function setCollaborators(ctx: ServiceContext, taskId: string, userIds: string[]) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { task, scope } = await loadTask(tx, ctx, taskId);
    if (!canEditTask(ctx, scope, task)) throw new ForbiddenError();
    for (const u of userIds) await assertAssignable(tx, task.projectId, u);
    await tx.taskCollaborator.deleteMany({ where: { taskId } });
    if (userIds.length) await tx.taskCollaborator.createMany({ data: [...new Set(userIds)].map((userId) => ({ organizationId: ctx.orgId, taskId, userId })) });
    await audit(tx, ctx, { action: "task.collaborators", entityType: "TASK", entityId: taskId, projectId: task.projectId, after: { userIds } });
  });
}

/** Adds a dependency after rejecting cycles (DFS over the project's dependency graph). */
export async function addDependency(ctx: ServiceContext, taskId: string, dependsOnId: string) {
  if (taskId === dependsOnId) throw new ValidationError("errors.dependencyCycle");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { task, scope } = await loadTask(tx, ctx, taskId);
    if (!canEditTask(ctx, scope, task)) throw new ForbiddenError();
    const other = await tx.task.findFirst({ where: { id: dependsOnId, projectId: task.projectId } });
    if (!other) throw new NotFoundError();
    // serialise graph edits per project so two concurrent edges can't form a cycle
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deps:${task.projectId}`}))`;
    const edges = await tx.taskDependency.findMany({ where: { task: { projectId: task.projectId } }, select: { taskId: true, dependsOnId: true } });
    if (wouldCreateCycle(edges, taskId, dependsOnId)) throw new ValidationError("errors.dependencyCycle");
    await tx.taskDependency.upsert({ where: { taskId_dependsOnId: { taskId, dependsOnId } }, create: { organizationId: ctx.orgId, taskId, dependsOnId }, update: {} });
    await audit(tx, ctx, { action: "task.dependency_add", entityType: "TASK", entityId: taskId, projectId: task.projectId, meta: { dependsOnId } });
  });
}

export function wouldCreateCycle(edges: { taskId: string; dependsOnId: string }[], taskId: string, dependsOnId: string): boolean {
  // adding taskId -> dependsOnId creates a cycle iff dependsOnId can already reach taskId
  const adj = new Map<string, string[]>();
  for (const e of edges) (adj.get(e.taskId) ?? adj.set(e.taskId, []).get(e.taskId)!).push(e.dependsOnId);
  const stack = [dependsOnId];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === taskId) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(adj.get(n) ?? []));
  }
  return false;
}

export async function removeDependency(ctx: ServiceContext, taskId: string, dependsOnId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { task, scope } = await loadTask(tx, ctx, taskId);
    if (!canEditTask(ctx, scope, task)) throw new ForbiddenError();
    await tx.taskDependency.deleteMany({ where: { taskId, dependsOnId } });
    await audit(tx, ctx, { action: "task.dependency_remove", entityType: "TASK", entityId: taskId, projectId: task.projectId, meta: { dependsOnId } });
  });
}

// ── Checklists ─────────────────────────────────────────────────────────────

export async function addChecklistItem(ctx: ServiceContext, input: { taskId: string; checklistId?: string | null; label: string }) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { task, scope } = await loadTask(tx, ctx, input.taskId);
    if (!canEditTask(ctx, scope, task)) throw new ForbiddenError();
    let checklistId = input.checklistId;
    if (checklistId) {
      if (!(await tx.checklist.findFirst({ where: { id: checklistId, taskId: task.id } }))) throw new NotFoundError();
    } else {
      const cl = (await tx.checklist.findFirst({ where: { taskId: task.id } })) ?? (await tx.checklist.create({ data: { organizationId: ctx.orgId, taskId: task.id, title: ctx.locale === "en" ? "Checklist" : "قائمة التحقق" } }));
      checklistId = cl.id;
    }
    const count = await tx.checklistItem.count({ where: { checklistId } });
    return tx.checklistItem.create({ data: { organizationId: ctx.orgId, checklistId, label: input.label, sortOrder: count } });
  });
}

export async function toggleChecklistItem(ctx: ServiceContext, itemId: string, done: boolean) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const item = await tx.checklistItem.findUnique({ where: { id: itemId }, include: { checklist: true } });
    if (!item) throw new NotFoundError();
    const { task, scope } = await loadTask(tx, ctx, item.checklist.taskId);
    if (!canEditTask(ctx, scope, task) && task.ownerId !== ctx.userId) throw new ForbiddenError();
    await tx.checklistItem.update({ where: { id: itemId }, data: { done, doneById: done ? ctx.userId : null, doneAt: done ? new Date() : null } });
    await audit(tx, ctx, { action: done ? "checklist.check" : "checklist.uncheck", entityType: "TASK", entityId: task.id, projectId: task.projectId, summary: item.label });
  });
}

// ── Comments (internal vs client-visible) ──────────────────────────────────

export async function addComment(ctx: ServiceContext, input: { entityType: string; entityId: string; projectId: string; body: string; visibility: "INTERNAL" | "CLIENT"; mentions?: string[] }) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (scope.fieldOnly) throw new ForbiddenError();
    // clients can only post client-visible comments; staff choose
    const visibility = scope.clientView ? "CLIENT" : input.visibility;
    if (input.entityType === "TASK") {
      const t = await tx.task.findFirst({ where: { id: input.entityId, projectId: input.projectId }, include: { collaborators: true } });
      if (!t) throw new NotFoundError();
      assertTaskVisible(ctx, scope, t);
    } else if (!(await commentTargetInProject(tx, input.entityType, input.entityId, input.projectId))) {
      throw new NotFoundError();
    }
    // mentions are restricted to project members (and for client comments, nobody outside the project)
    const members = await tx.projectMember.findMany({ where: { projectId: input.projectId }, select: { userId: true, role: true } });
    const internalOnly = visibility === "INTERNAL";
    const allowed = new Set(members.filter((m) => !internalOnly || !["CLIENT_VIEWER", "CLIENT_APPROVER", "VENDOR"].includes(m.role)).map((m) => m.userId));
    const mentions = (input.mentions ?? []).filter((u) => allowed.has(u) && u !== ctx.userId);
    const c = await tx.comment.create({ data: { organizationId: ctx.orgId, projectId: input.projectId, entityType: input.entityType, entityId: input.entityId, authorId: ctx.userId, body: input.body, visibility, mentions } });
    await audit(tx, ctx, { action: "comment.create", entityType: input.entityType, entityId: input.entityId, projectId: input.projectId, meta: { visibility, mentions: mentions.length } });
    if (mentions.length) await emit(tx, ctx, "comment.mentioned", { projectId: input.projectId, mentions, name: ctx.userName, title: input.body.slice(0, 80), link: input.entityType === "TASK" ? `/tasks/${input.entityId}` : `/projects/${input.projectId}` });
    return c;
  });
}

/** A comment thread may only be attached to a record of the project it claims. */
async function commentTargetInProject(tx: Tx, entityType: string, entityId: string, projectId: string): Promise<boolean> {
  const where = { id: entityId, projectId };
  switch (entityType) {
    case "PROJECT": return entityId === projectId;
    case "DELIVERY": return !!(await tx.delivery.findFirst({ where, select: { id: true } }));
    case "APPROVAL": return !!(await tx.approval.findFirst({ where, select: { id: true } }));
    case "BOOTH": return !!(await tx.booth.findFirst({ where, select: { id: true } }));
    case "INCIDENT": return !!(await tx.incident.findFirst({ where, select: { id: true } }));
    case "CHANGE_REQUEST": return !!(await tx.changeRequest.findFirst({ where, select: { id: true } }));
    default: return false;
  }
}

export async function listComments(tx: Tx, scope: ProjectScope, entityType: string, entityId: string) {
  return tx.comment.findMany({
    where: { entityType, entityId, deletedAt: null, ...(scope.clientView ? { visibility: "CLIENT" } : {}) },
    include: { author: { select: { id: true, name: true, nameAr: true } } },
    orderBy: { createdAt: "asc" },
  });
}

// ── Queries ────────────────────────────────────────────────────────────────

export interface TaskFilters {
  workstreamId?: string;
  ownerId?: string;
  status?: string;
  category?: string;
  q?: string;
  overdue?: boolean;
  tag?: string;
}

export async function listProjectTasks(ctx: ServiceContext, projectId: string, f: TaskFilters = {}) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (scope.fieldOnly) throw new NotFoundError();
    const where: Prisma.TaskWhereInput = {
      ...(taskVisibilityWhere(ctx, scope) as Prisma.TaskWhereInput),
      parentId: null,
      ...(f.workstreamId ? { workstreamId: f.workstreamId } : {}),
      ...(f.ownerId ? { ownerId: f.ownerId === "none" ? null : f.ownerId } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.category ? { statusCategory: f.category as StatusCategory } : {}),
      ...(f.q ? { title: { contains: f.q, mode: "insensitive" } } : {}),
      ...(f.overdue ? { dueAt: { lt: new Date() }, statusCategory: { notIn: ["DONE", "CANCELLED"] } } : {}),
      ...(f.tag ? { tags: { has: f.tag } } : {}),
    };
    const [tasks, workstreams, members] = await Promise.all([
      tx.task.findMany({
        where,
        include: {
          owner: { select: { id: true, name: true, nameAr: true } },
          _count: { select: { subtasks: true, dependencies: true } },
          checklists: { select: { items: { select: { done: true } } } },
          dependencies: { select: { dependsOn: { select: { statusCategory: true } } } },
        },
        orderBy: [{ sortOrder: "asc" }, { number: "asc" }],
        take: 2000,
      }),
      tx.workstream.findMany({ where: { projectId, ...(scope.workstreamIds.length ? { id: { in: scope.workstreamIds } } : {}) }, orderBy: { sortOrder: "asc" } }),
      tx.projectMember.findMany({ where: { projectId }, include: { user: { select: { id: true, name: true, nameAr: true } } } }),
    ]);
    return {
      scope,
      workstreams: workstreams.map((w) => ({ id: w.id, key: w.key, name: (ctx.locale === "en" && w.nameEn) || w.name, kind: w.kind, color: w.color, statuses: statusesOf(w) })),
      members: members.filter((m) => !["CLIENT_VIEWER", "CLIENT_APPROVER"].includes(m.role)).map((m) => ({ id: m.userId, name: (ctx.locale === "ar" ? m.user.nameAr : null) ?? m.user.name, role: m.role })),
      tasks: tasks.map((t) => {
        const items = t.checklists.flatMap((c) => c.items);
        return {
          id: t.id, number: t.number, title: t.title, status: t.status, statusCategory: t.statusCategory, priority: t.priority, workstreamId: t.workstreamId,
          owner: t.owner ? { id: t.owner.id, name: (ctx.locale === "ar" ? t.owner.nameAr : null) ?? t.owner.name } : null,
          startAt: t.startAt, dueAt: t.dueAt, completedAt: t.completedAt, tags: t.tags, requiresApproval: t.requiresApproval, clientVisible: t.clientVisible, escalatedAt: t.escalatedAt, version: t.version,
          estimateMinutes: t.estimateMinutes, actualMinutes: t.actualMinutes,
          subtasks: t._count.subtasks, checklist: { done: items.filter((i) => i.done).length, total: items.length },
          blockedByDeps: t.dependencies.some((d) => !["DONE", "CANCELLED"].includes(d.dependsOn.statusCategory)),
        };
      }),
    };
  });
}

export type BoardTask = Awaited<ReturnType<typeof listProjectTasks>>["tasks"][number];

export async function getTaskDetail(ctx: ServiceContext, taskId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { task, scope } = await loadTask(tx, ctx, taskId);
    const [full, comments, attachments, approvals, history, auditTrail, members, projectTasks] = await Promise.all([
      tx.task.findUniqueOrThrow({
        where: { id: taskId },
        include: {
          project: { select: { id: true, code: true, name: true, nameEn: true } },
          owner: { select: { id: true, name: true, nameAr: true } },
          collaborators: { include: { user: { select: { id: true, name: true, nameAr: true } } } },
          subtasks: { orderBy: { number: "asc" }, select: { id: true, number: true, title: true, statusCategory: true, status: true, ownerId: true, dueAt: true } },
          checklists: { include: { items: { orderBy: { sortOrder: "asc" } } }, orderBy: { sortOrder: "asc" } },
          dependencies: { include: { dependsOn: { select: { id: true, number: true, title: true, statusCategory: true } } } },
          dependents: { include: { task: { select: { id: true, number: true, title: true, statusCategory: true } } } },
          parent: { select: { id: true, number: true, title: true } },
        },
      }),
      listComments(tx, scope, "TASK", taskId),
      tx.attachment.findMany({ where: { entityType: "TASK", entityId: taskId, deletedAt: null, ...(scope.clientView ? { clientVisible: true } : {}) }, orderBy: { createdAt: "desc" } }),
      tx.approval.findMany({ where: { entityType: "TASK", entityId: taskId, ...(scope.clientView ? { clientVisible: true } : {}) }, include: { decisions: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "desc" } }),
      tx.taskAssignmentHistory.findMany({ where: { taskId }, orderBy: { createdAt: "desc" } }),
      scope.clientView ? Promise.resolve([]) : tx.auditEvent.findMany({ where: { entityType: "TASK", entityId: taskId }, orderBy: { createdAt: "desc" }, take: 50 }),
      tx.projectMember.findMany({ where: { projectId: task.projectId }, include: { user: { select: { id: true, name: true, nameAr: true } } } }),
      // dependency picker: only tasks the caller may see in this project
      tx.task.findMany({ where: { ...(taskVisibilityWhere(ctx, scope) as Prisma.TaskWhereInput), id: { not: taskId }, parentId: null }, select: { id: true, number: true, title: true }, orderBy: { number: "asc" }, take: 500 }),
    ]);
    // Same rule as decideApproval, so the UI never offers a decision the server would refuse.
    const active = !(INACTIVE_PROJECT_STATUSES as readonly string[]).includes(scope.project.status);
    const requestLike = { entityType: "TASK", entityId: taskId, requestedById: ctx.userId, approverUserId: null, clientVisible: true };
    const [internalApprovers, clientApprovers] = scope.clientView || !active
      ? [{ eligible: [] as string[] }, { eligible: [] as string[] }]
      : await Promise.all([
          resolveApproverSet(tx, scope.project, { ...requestLike, approverType: "INTERNAL" }),
          resolveApproverSet(tx, scope.project, { ...requestLike, approverType: "CLIENT" }),
        ]);
    return {
      task: full,
      statuses: statusesOf(task.workstream),
      workstream: task.workstream ? { id: task.workstream.id, name: (ctx.locale === "en" && task.workstream.nameEn) || task.workstream.name } : null,
      comments,
      attachments,
      approvals: approvals.map((a) => ({ ...a, canDecide: active && a.status === "PENDING" && mayDecide(ctx, scope, a, null) })),
      eligibleApprovers: { INTERNAL: internalApprovers.eligible, CLIENT: clientApprovers.eligible },
      history,
      auditTrail,
      members: members.map((m) => ({ id: m.userId, name: (ctx.locale === "ar" ? m.user.nameAr : null) ?? m.user.name, role: m.role })),
      projectTasks,
      canEdit: canEditTask(ctx, scope, task),
      scope: { manage: scope.manage, clientView: scope.clientView, approve: scope.approve },
    };
  });
}

/** Cross-project "my work": tasks owned by or shared with the caller. */
export async function myWork(ctx: ServiceContext) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const tasks = await tx.task.findMany({
      where: { statusCategory: { notIn: ["DONE", "CANCELLED"] }, OR: [{ ownerId: ctx.userId }, { collaborators: { some: { userId: ctx.userId } } }] },
      include: { project: { select: { id: true, code: true, name: true, nameEn: true } } },
      orderBy: [{ dueAt: "asc" }],
      take: 500,
    });
    const approvals = await tx.approval.findMany({ where: { status: "PENDING", approverUserId: ctx.userId }, orderBy: { createdAt: "desc" }, take: 50 });
    return { tasks, approvals };
  });
}

// ── Bulk ───────────────────────────────────────────────────────────────────

export const bulkInput = z.object({
  projectId: z.string(),
  taskIds: z.array(z.string()).min(1).max(500),
  set: z.object({ ownerId: z.string().nullable().optional(), priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(), status: z.string().optional(), dueAt: optDate, clientVisible: z.boolean().optional(), addTag: z.string().optional() }),
});

export async function bulkUpdateTasks(ctx: ServiceContext, input: z.output<typeof bulkInput>) {
  const results = { updated: 0, skipped: [] as { id: string; reason: string }[] };
  // Status changes go through the workflow one by one so rules (deps/approvals) still hold.
  if (input.set.status) {
    for (const id of input.taskIds) {
      try {
        await changeTaskStatus(ctx, { id, status: input.set.status });
        results.updated++;
      } catch (e) {
        results.skipped.push({ id, reason: (e as Error).message });
      }
    }
  }
  const { status: _s, addTag, ...rest } = input.set;
  if (Object.keys(rest).length || addTag) {
    await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
      const scope = await projectScope(tx, ctx, input.projectId);
      if (!scope.operate || scope.clientView || scope.taskScope === "assigned") throw new ForbiddenError();
      if (rest.clientVisible !== undefined && !scope.manage) throw new ForbiddenError();
      if (rest.ownerId) await assertAssignable(tx, input.projectId, rest.ownerId);
      // write scope = read scope (workstream restrictions included)
      const tasks = await tx.task.findMany({ where: { ...(taskVisibilityWhere(ctx, scope) as Prisma.TaskWhereInput), id: { in: input.taskIds } } });
      for (const t of tasks) {
        await tx.task.update({ where: { id: t.id }, data: { ...rest, ...(addTag && !t.tags.includes(addTag) ? { tags: { push: addTag } } : {}), version: { increment: 1 } } });
        if (rest.ownerId !== undefined && rest.ownerId !== t.ownerId) {
          await tx.taskAssignmentHistory.create({ data: { organizationId: ctx.orgId, taskId: t.id, fromUserId: t.ownerId, toUserId: rest.ownerId, changedById: ctx.userId, reason: "bulk" } });
          if (rest.ownerId) await emit(tx, ctx, "task.assigned", { taskId: t.id, projectId: t.projectId, ownerId: rest.ownerId, title: t.title, link: `/tasks/${t.id}`, entityType: "TASK", entityId: t.id });
        }
      }
      if (!input.set.status) results.updated = tasks.length;
      await audit(tx, ctx, { action: "task.bulk_update", entityType: "TASK", projectId: input.projectId, summary: `${tasks.length} tasks`, after: { ...rest, addTag } });
    });
  }
  return results;
}
