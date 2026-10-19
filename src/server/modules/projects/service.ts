import type { z } from "zod";
import type { Prisma, ProjectStatus } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan, can, projectScope, projectVisibilityWhere, type ProjectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { emit } from "@/server/modules/automation/outbox";
import { applyTemplateVersion } from "@/server/modules/templates/service";
import { computeHealth } from "./health";
import type { createProjectSchema, deliverableSchema, memberSchema, milestoneSchema, projectSchema, riskSchema } from "./schemas";

async function nextProjectCode(tx: Tx, year: number) {
  const prefix = `PRJ-${year}-`;
  const last = await tx.project.findFirst({ where: { code: { startsWith: prefix } }, orderBy: { code: "desc" }, select: { code: true } });
  const n = last ? Number(last.code.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(3, "0")}`;
}

export async function createProject(ctx: ServiceContext, input: z.output<typeof createProjectSchema>) {
  assertCan(ctx, "project.create");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    if (input.clientId && !(await tx.client.findUnique({ where: { id: input.clientId } }))) throw new ValidationError("errors.validation", { clientId: ["errors.notFound"] });
    const year = (input.startDate ?? new Date()).getFullYear();
    let code = await nextProjectCode(tx, year);
    // the unique index (organizationId, code) is the final guard; retry once on a race
    const exists = await tx.project.findUnique({ where: { organizationId_code: { organizationId: ctx.orgId, code } } });
    if (exists) code = `${code}-${Date.now().toString(36).slice(-3).toUpperCase()}`;
    const { templateIds, venueIds, managerId, ...data } = input;
    const project = await tx.project.create({ data: { ...data, organizationId: ctx.orgId, code, createdById: ctx.userId, status: "PLANNING" } });
    const managers = new Set([ctx.userId, ...(managerId ? [managerId] : [])]);
    for (const uid of managers) {
      const m = await tx.membership.findFirst({ where: { userId: uid, status: "ACTIVE" } });
      if (!m) continue;
      await tx.projectMember.create({ data: { organizationId: ctx.orgId, projectId: project.id, userId: uid, role: "MANAGER", canApprove: true, canExport: true, canViewFinance: true, canViewVip: true, addedById: ctx.userId } });
    }
    if (venueIds.length) {
      const venues = await tx.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true } });
      await tx.projectVenue.createMany({ data: venues.map((v) => ({ organizationId: ctx.orgId, projectId: project.id, venueId: v.id })) });
    }
    await audit(tx, ctx, { action: "project.create", entityType: "PROJECT", entityId: project.id, projectId: project.id, summary: `${code} ${project.name}`, after: { type: project.type, templates: templateIds } });
    const applied = [];
    for (const templateId of templateIds) {
      const latest = await tx.templateVersion.findFirst({ where: { templateId }, orderBy: { version: "desc" } });
      if (!latest) throw new NotFoundError();
      applied.push(await applyTemplateVersion(tx, ctx, project, latest.id));
    }
    if (!templateIds.length) {
      await tx.workstream.create({ data: { organizationId: ctx.orgId, projectId: project.id, key: "general", name: "عام", nameEn: "General", statuses: (await import("@/server/modules/templates/definition")).DEFAULT_STATUSES as unknown as Prisma.InputJsonValue } });
    }
    return { project, applied };
  }, { timeout: 60_000 });
}

export async function updateProject(ctx: ServiceContext, projectId: string, input: z.output<typeof projectSchema>) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (!scope.manage) throw new ForbiddenError();
    const { venueIds, managerId: _m, ...data } = input;
    if (!scope.finance) delete (data as Partial<typeof data>).budgetAmount;
    const updated = await tx.project.update({ where: { id: projectId }, data });
    await tx.projectVenue.deleteMany({ where: { projectId } });
    if (venueIds.length) {
      const venues = await tx.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true } });
      await tx.projectVenue.createMany({ data: venues.map((v) => ({ organizationId: ctx.orgId, projectId, venueId: v.id })) });
    }
    await audit(tx, ctx, { action: "project.update", entityType: "PROJECT", entityId: projectId, projectId, before: pick(scope.project), after: pick(updated) });
    return updated;
  });
}

function pick(p: { name: string; status: string; priority: string; deadline: Date | null; eventStartAt: Date | null; budgetAmount: unknown }) {
  return { name: p.name, status: p.status, priority: p.priority, deadline: p.deadline, eventStartAt: p.eventStartAt, budgetAmount: p.budgetAmount?.toString() ?? null };
}

export async function setProjectStatus(ctx: ServiceContext, projectId: string, status: ProjectStatus) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (!scope.manage) throw new ForbiddenError();
    const before = scope.project.status;
    if (before === status) return scope.project;
    const p = await tx.project.update({ where: { id: projectId }, data: { status, archivedAt: status === "CLOSED" || status === "CANCELLED" ? new Date() : null } });
    await audit(tx, ctx, { action: "project.status", entityType: "PROJECT", entityId: projectId, projectId, before: { status: before }, after: { status } });
    if (status === "COMPLETED") await emit(tx, ctx, "project.completed", { projectId, title: p.name, code: p.code, link: `/projects/${projectId}` });
    return p;
  });
}

// ── Queries ────────────────────────────────────────────────────────────────

export interface PortfolioFilters {
  status?: string;
  clientId?: string;
  q?: string;
  includeClosed?: boolean;
}

export async function listProjects(ctx: ServiceContext, f: PortfolioFilters = {}) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const where: Prisma.ProjectWhereInput = {
      ...projectVisibilityWhere(ctx),
      ...(f.status ? { status: f.status as ProjectStatus } : f.includeClosed ? {} : { status: { notIn: ["CLOSED", "CANCELLED"] } }),
      ...(f.clientId ? { clientId: f.clientId } : {}),
      ...(f.q ? { OR: [{ name: { contains: f.q, mode: "insensitive" } }, { code: { contains: f.q, mode: "insensitive" } }, { nameEn: { contains: f.q, mode: "insensitive" } }] } : {}),
    };
    const projects = await tx.project.findMany({
      where,
      include: {
        client: { select: { id: true, name: true } },
        members: { where: { role: "MANAGER" }, include: { user: { select: { id: true, name: true, nameAr: true } } } },
        workstreams: { select: { id: true, kind: true, name: true, nameEn: true, color: true } },
      },
      orderBy: [{ eventStartAt: "asc" }, { createdAt: "desc" }],
      take: 500,
    });
    const ids = projects.map((p) => p.id);
    const now = new Date();
    const [byCat, overdue, risks, milestonesBlocked] = await Promise.all([
      tx.task.groupBy({ by: ["projectId", "statusCategory"], where: { projectId: { in: ids }, parentId: null }, _count: true }),
      tx.task.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, parentId: null, statusCategory: { notIn: ["DONE", "CANCELLED"] }, dueAt: { lt: now } }, _count: true }),
      tx.risk.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, status: { not: "CLOSED" }, likelihood: { gte: 3 }, impact: { gte: 3 } }, _count: true }),
      tx.milestone.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, OR: [{ status: "BLOCKED" }, { status: { not: "DONE" }, dueDate: { lt: now } }] }, _count: true }),
    ]);
    return projects.map((p) => {
      const cats = byCat.filter((c) => c.projectId === p.id);
      const total = cats.filter((c) => c.statusCategory !== "CANCELLED").reduce((n, c) => n + c._count, 0);
      const done = cats.find((c) => c.statusCategory === "DONE")?._count ?? 0;
      const blocked = cats.find((c) => c.statusCategory === "BLOCKED")?._count ?? 0;
      const od = overdue.find((o) => o.projectId === p.id)?._count ?? 0;
      const elapsed = p.startDate && p.deadline ? Math.max(0, Math.min(1, (now.getTime() - p.startDate.getTime()) / Math.max(1, p.deadline.getTime() - p.startDate.getTime()))) : null;
      const health = computeHealth({ totalTasks: total, doneTasks: done, overdueTasks: od, blockedTasks: blocked, openHighRisks: risks.find((r) => r.projectId === p.id)?._count ?? 0, blockedMilestones: milestonesBlocked.find((r) => r.projectId === p.id)?._count ?? 0, overdueMilestones: 0, elapsed, budgetRatio: null });
      return {
        id: p.id,
        code: p.code,
        name: (ctx.locale === "en" && p.nameEn) || p.name,
        type: p.type,
        status: p.status,
        priority: p.priority,
        client: p.client,
        startDate: p.startDate,
        deadline: p.deadline,
        eventStartAt: p.eventStartAt,
        eventEndAt: p.eventEndAt,
        managers: p.members.map((m) => (ctx.locale === "ar" ? m.user.nameAr : null) ?? m.user.name),
        workstreams: p.workstreams.map((w) => ({ id: w.id, kind: w.kind, name: (ctx.locale === "en" && w.nameEn) || w.name, color: w.color })),
        tasks: { total, done, overdue: od, blocked },
        progress: total ? done / total : 0,
        health,
        budgetAmount: can(ctx, "finance.view") ? p.budgetAmount?.toString() ?? null : null,
      };
    });
  });
}

export type PortfolioProject = Awaited<ReturnType<typeof listProjects>>[number];

export async function getProjectOverview(ctx: ServiceContext, projectId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (scope.fieldOnly) throw new NotFoundError();
    const now = new Date();
    const clientOnly = scope.clientView ? { clientVisible: true } : {};
    const [project, workstreams, milestones, deliverables, risks, members, approvals, catCounts, overdue, activity, instances, campaigns, events, booths] = await Promise.all([
      tx.project.findUniqueOrThrow({ where: { id: projectId }, include: { client: true, venues: { include: { venue: true } } } }),
      tx.workstream.findMany({ where: { projectId, ...(scope.workstreamIds.length ? { id: { in: scope.workstreamIds } } : {}) }, orderBy: { sortOrder: "asc" } }),
      tx.milestone.findMany({ where: { projectId, ...clientOnly }, orderBy: [{ dueDate: "asc" }, { sortOrder: "asc" }] }),
      tx.deliverable.findMany({ where: { projectId, ...clientOnly }, orderBy: { dueDate: "asc" } }),
      scope.clientView ? Promise.resolve([]) : tx.risk.findMany({ where: { projectId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] }),
      tx.projectMember.findMany({ where: { projectId }, include: { user: { select: { id: true, name: true, nameAr: true, email: true } } } }),
      tx.approval.findMany({ where: { projectId, status: "PENDING", ...(scope.clientView ? { approverType: "CLIENT" } : {}) }, orderBy: { createdAt: "desc" }, take: 20 }),
      tx.task.groupBy({ by: ["workstreamId", "statusCategory"], where: { projectId, parentId: null, ...(scope.clientView ? { clientVisible: true } : {}) }, _count: true }),
      tx.task.count({ where: { projectId, parentId: null, statusCategory: { notIn: ["DONE", "CANCELLED"] }, dueAt: { lt: now }, ...(scope.clientView ? { clientVisible: true } : {}) } }),
      scope.clientView ? Promise.resolve([]) : tx.auditEvent.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 25 }),
      tx.templateInstance.findMany({ where: { projectId }, orderBy: { appliedAt: "asc" } }),
      tx.invitationCampaign.findMany({ where: { projectId }, select: { id: true, name: true, type: true, status: true } }),
      tx.event.findMany({ where: { projectId }, select: { id: true, name: true, startsAt: true, phase: true } }),
      tx.booth.findMany({ where: { projectId }, select: { id: true, name: true, stage: true, kind: true } }),
    ]);
    const total = catCounts.filter((c) => c.statusCategory !== "CANCELLED").reduce((n, c) => n + c._count, 0);
    const done = catCounts.filter((c) => c.statusCategory === "DONE").reduce((n, c) => n + c._count, 0);
    const blocked = catCounts.filter((c) => c.statusCategory === "BLOCKED").reduce((n, c) => n + c._count, 0);
    let budgetRatio: number | null = null;
    let finance: { planned: number; committed: number; actual: number } | null = null;
    if (scope.finance) {
      const [budgets, pos, expenses] = await Promise.all([
        tx.budget.aggregate({ where: { projectId }, _sum: { planned: true } }),
        tx.purchaseOrder.aggregate({ where: { projectId, status: { in: ["APPROVED", "ISSUED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED"] } }, _sum: { amount: true } }),
        tx.expense.aggregate({ where: { projectId, status: { in: ["APPROVED", "PAID"] } }, _sum: { amount: true } }),
      ]);
      const planned = Number(budgets._sum.planned ?? project.budgetAmount ?? 0);
      finance = { planned, committed: Number(pos._sum.amount ?? 0), actual: Number(expenses._sum.amount ?? 0) };
      budgetRatio = planned > 0 ? finance.actual / planned : null;
    }
    const elapsed = project.startDate && project.deadline ? Math.max(0, Math.min(1, (now.getTime() - project.startDate.getTime()) / Math.max(1, project.deadline.getTime() - project.startDate.getTime()))) : null;
    const health = computeHealth({
      totalTasks: total,
      doneTasks: done,
      overdueTasks: overdue,
      blockedTasks: blocked,
      openHighRisks: risks.filter((r) => r.status !== "CLOSED" && r.likelihood >= 3 && r.impact >= 3).length,
      blockedMilestones: milestones.filter((m) => m.status === "BLOCKED").length,
      overdueMilestones: milestones.filter((m) => m.status !== "DONE" && m.dueDate && m.dueDate < now).length,
      elapsed,
      budgetRatio,
    });
    const wsProgress = workstreams.map((w) => {
      const c = catCounts.filter((x) => x.workstreamId === w.id);
      const t = c.filter((x) => x.statusCategory !== "CANCELLED").reduce((n, x) => n + x._count, 0);
      const d = c.filter((x) => x.statusCategory === "DONE").reduce((n, x) => n + x._count, 0);
      return { ...w, total: t, done: d, blocked: c.filter((x) => x.statusCategory === "BLOCKED").reduce((n, x) => n + x._count, 0) };
    });
    if (!scope.finance) (project as { budgetAmount: unknown }).budgetAmount = null;
    return { scope: scopeSummary(scope), project, workstreams: wsProgress, milestones, deliverables, risks, members, approvals, tasks: { total, done, blocked, overdue }, health, finance, activity, instances, campaigns, events, booths };
  });
}

export function scopeSummary(s: ProjectScope) {
  return { manage: s.manage, operate: s.operate, finance: s.finance, vip: s.vip, export: s.export, approve: s.approve, clientView: s.clientView, fieldOnly: s.fieldOnly, taskScope: s.taskScope, workstreamIds: s.workstreamIds };
}

/** Lightweight header data for project sub-pages. */
export async function getProjectHeader(ctx: ServiceContext, projectId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    const p = scope.project;
    const workstreams = await tx.workstream.findMany({ where: { projectId }, select: { kind: true } });
    return { id: p.id, code: p.code, name: (ctx.locale === "en" && p.nameEn) || p.name, status: p.status, type: p.type, currency: p.currency, kinds: [...new Set(workstreams.map((w) => w.kind))], scope: scopeSummary(scope) };
  });
}

// ── Members ────────────────────────────────────────────────────────────────

export async function upsertProjectMember(ctx: ServiceContext, input: z.output<typeof memberSchema>) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.manage) throw new ForbiddenError();
    const membership = await tx.membership.findFirst({ where: { userId: input.userId, status: "ACTIVE" }, include: { role: true } });
    if (!membership) throw new NotFoundError();
    const external = ["CLIENT", "CLIENT_APPROVER"].includes(membership.role.baseRole);
    if (external && !["CLIENT_VIEWER", "CLIENT_APPROVER"].includes(input.role)) throw new ValidationError("errors.validation", { role: ["errors.forbidden"] });
    if (external && membership.clientId !== scope.project.clientId) throw new ValidationError("errors.validation", { userId: ["errors.forbidden"] });
    const { projectId, userId, ...flags } = input;
    // capability flags cannot exceed the granter's own project scope
    if (flags.canViewFinance && !scope.finance) flags.canViewFinance = false;
    if (flags.canViewVip && !scope.vip) flags.canViewVip = false;
    const before = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
    const pm = await tx.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { organizationId: ctx.orgId, projectId, userId, ...flags, addedById: ctx.userId },
      update: flags,
    });
    await audit(tx, ctx, { action: before ? "project.member_update" : "project.member_add", entityType: "PROJECT_MEMBER", entityId: pm.id, projectId, before: before ? { role: before.role, finance: before.canViewFinance, vip: before.canViewVip } : undefined, after: { userId, role: pm.role, finance: pm.canViewFinance, vip: pm.canViewVip, export: pm.canExport } });
    return pm;
  });
}

export async function removeProjectMember(ctx: ServiceContext, projectId: string, userId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (!scope.manage) throw new ForbiddenError();
    const managers = await tx.projectMember.count({ where: { projectId, role: "MANAGER" } });
    const target = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (!target) throw new NotFoundError();
    if (target.role === "MANAGER" && managers <= 1) throw new ValidationError("errors.lastOwner");
    await tx.projectMember.delete({ where: { id: target.id } });
    await audit(tx, ctx, { action: "project.member_remove", entityType: "PROJECT_MEMBER", entityId: target.id, projectId, meta: { userId } });
  });
}

// ── Milestones, risks, deliverables ────────────────────────────────────────

export async function saveMilestone(ctx: ServiceContext, input: z.output<typeof milestoneSchema>) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.operate) throw new ForbiddenError();
    const { id, ...data } = input;
    const before = id ? await tx.milestone.findFirst({ where: { id, projectId: input.projectId } }) : null;
    if (id && !before) throw new NotFoundError();
    const m = id
      ? await tx.milestone.update({ where: { id }, data: { ...data, completedAt: data.status === "DONE" ? before?.completedAt ?? new Date() : null } })
      : await tx.milestone.create({ data: { ...data, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: id ? "milestone.update" : "milestone.create", entityType: "MILESTONE", entityId: m.id, projectId: m.projectId, before: before ? { status: before.status, dueDate: before.dueDate } : undefined, after: { status: m.status, dueDate: m.dueDate } });
    if (m.status === "BLOCKED" && before?.status !== "BLOCKED") await emit(tx, ctx, "milestone.blocked", { projectId: m.projectId, title: m.title, link: `/projects/${m.projectId}`, entityType: "MILESTONE", entityId: m.id });
    return m;
  });
}

export async function saveRisk(ctx: ServiceContext, input: z.output<typeof riskSchema>) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.operate || scope.clientView) throw new ForbiddenError();
    const { id, ...data } = input;
    if (id && !(await tx.risk.findFirst({ where: { id, projectId: input.projectId } }))) throw new NotFoundError();
    const r = id ? await tx.risk.update({ where: { id }, data }) : await tx.risk.create({ data: { ...data, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: id ? "risk.update" : "risk.create", entityType: "RISK", entityId: r.id, projectId: r.projectId, after: { title: r.title, score: r.likelihood * r.impact, status: r.status } });
    return r;
  });
}

export async function saveDeliverable(ctx: ServiceContext, input: z.output<typeof deliverableSchema>) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.operate) throw new ForbiddenError();
    const { id, ...data } = input;
    const before = id ? await tx.deliverable.findFirst({ where: { id, projectId: input.projectId } }) : null;
    if (id && !before) throw new NotFoundError();
    // approval-gated deliverables can only become APPROVED through an approval decision
    if (data.status === "APPROVED" && (before?.requiresApproval ?? data.requiresApproval) && before?.status !== "APPROVED") throw new ValidationError("errors.approvalRequired");
    const d = id ? await tx.deliverable.update({ where: { id }, data }) : await tx.deliverable.create({ data: { ...data, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: id ? "deliverable.update" : "deliverable.create", entityType: "DELIVERABLE", entityId: d.id, projectId: d.projectId, before: before ? { status: before.status } : undefined, after: { status: d.status } });
    return d;
  });
}

export async function listChangeRequests(ctx: ServiceContext, projectId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    await projectScope(tx, ctx, projectId);
    return tx.changeRequest.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
  });
}
