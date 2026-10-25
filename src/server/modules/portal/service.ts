import { z } from "zod";
import type { ServiceContext } from "@/server/authz/context";
import { isClientRole } from "@/server/authz/roles";
import { can, projectScope, type ProjectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { notify } from "@/server/modules/notifications/notify";

export const changeRequestSchema = z.object({ projectId: z.string(), title: z.string().trim().min(3).max(200), description: z.string().trim().min(5).max(4000) });
export const changeResponseSchema = z.object({ id: z.string(), status: z.enum(["UNDER_REVIEW", "ACCEPTED", "DECLINED"]), response: z.string().trim().max(4000).nullish() });

const scoped = (ctx: ServiceContext) => ({ orgId: ctx.orgId, userId: ctx.userId });

function assertClient(ctx: ServiceContext) {
  if (!isClientRole(ctx.role) || !can(ctx, "portal.access")) throw new ForbiddenError();
}

async function clientScope(tx: Tx, ctx: ServiceContext, projectId: string): Promise<ProjectScope> {
  const s = await projectScope(tx, ctx, projectId); // NotFound unless member + clientPortal enabled
  if (!s.clientView) throw new NotFoundError();
  return s;
}

/**
 * "Approved progress" for clients: only client-visible tasks/milestones count, and a task counts as
 * done only when it is DONE (internal review stages are not exposed as progress).
 */
async function clientProgress(tx: Tx, projectIds: string[]) {
  const rows = await tx.task.groupBy({ by: ["projectId", "statusCategory"], where: { projectId: { in: projectIds }, clientVisible: true }, _count: true });
  return (pid: string) => {
    const r = rows.filter((x) => x.projectId === pid);
    const total = r.reduce((a, x) => a + x._count, 0);
    const done = r.filter((x) => x.statusCategory === "DONE").reduce((a, x) => a + x._count, 0);
    return { total, done, ratio: total ? done / total : null };
  };
}

export async function portalHome(ctx: ServiceContext) {
  assertClient(ctx);
  return withTenant(scoped(ctx), async (tx) => {
    const memberships = await tx.projectMember.findMany({ where: { userId: ctx.userId }, select: { projectId: true } });
    const projects = await tx.project.findMany({ where: { id: { in: memberships.map((m) => m.projectId) }, clientPortal: true, archivedAt: null, clientId: ctx.clientId ?? null }, select: { id: true, code: true, name: true, nameEn: true, status: true, eventStartAt: true, deadline: true }, orderBy: { eventStartAt: "asc" } });
    const ids = projects.map((p) => p.id);
    const progress = await clientProgress(tx, ids);
    const pending = await tx.approval.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, clientVisible: true, approverType: "CLIENT", status: "PENDING" }, _count: true });
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true, nameEn: true, brandColor: true } });
    return {
      org,
      projects: projects.map((p) => ({ ...p, name: (ctx.locale === "en" && p.nameEn) || p.name, progress: progress(p.id), pendingApprovals: pending.find((x) => x.projectId === p.id)?._count ?? 0 })),
    };
  });
}

/** Everything a client may see for one project. No recipient, guest or vendor-pricing data leaves here. */
export async function portalProject(ctx: ServiceContext, projectId: string) {
  assertClient(ctx);
  return withTenant(scoped(ctx), async (tx) => {
    const s = await clientScope(tx, ctx, projectId);
    const p = s.project;
    const [milestones, deliverables, approvals, files, requests, deliveries, rsvps, booths, changeOrders, tasks] = await Promise.all([
      tx.milestone.findMany({ where: { projectId, clientVisible: true }, orderBy: { dueDate: "asc" } }),
      tx.deliverable.findMany({ where: { projectId, clientVisible: true }, orderBy: { dueDate: "asc" } }),
      tx.approval.findMany({ where: { projectId, clientVisible: true }, include: { decisions: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "desc" } }),
      tx.attachment.findMany({ where: { projectId, clientVisible: true, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 200 }),
      tx.changeRequest.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } }),
      tx.delivery.groupBy({ by: ["status"], where: { projectId }, _count: true }),
      tx.digitalInvitation.groupBy({ by: ["rsvpStatus"], where: { projectId, status: { not: "SUPPRESSED" } }, _count: true }),
      tx.booth.findMany({ where: { projectId }, select: { id: true, name: true, stage: true, handoverAt: true, handoverSignedAt: true } }),
      tx.changeOrder.findMany({ where: { projectId, clientVisible: true }, orderBy: { createdAt: "desc" } }),
      tx.task.findMany({ where: { projectId, clientVisible: true }, select: { id: true, title: true, statusCategory: true, dueAt: true, completedAt: true }, orderBy: { dueAt: "asc" }, take: 200 }),
    ]);
    const progress = (await clientProgress(tx, [projectId]))(projectId);
    const d = Object.fromEntries(deliveries.map((x) => [x.status, x._count])) as Record<string, number>;
    const dTotal = Object.values(d).reduce((a, b) => a + b, 0) - (d.CANCELLED ?? 0);
    const r = Object.fromEntries(rsvps.map((x) => [x.rsvpStatus ?? "NONE", x._count])) as Record<string, number>;
    return {
      project: { id: p.id, code: p.code, name: (ctx.locale === "en" && p.nameEn) || p.name, status: p.status, eventStartAt: p.eventStartAt, deadline: p.deadline, description: p.description },
      canApprove: s.approve,
      progress,
      milestones: milestones.map((m) => ({ id: m.id, title: m.title, dueAt: m.dueDate, status: m.status, completedAt: m.completedAt })),
      // in-progress internal drafts aren't shown; clients see deliverables once submitted or decided
      deliverables: deliverables.filter((x) => ["SUBMITTED", "APPROVED", "REJECTED"].includes(x.status)).map((x) => ({ id: x.id, title: x.title, status: x.status, dueAt: x.dueDate })),
      // only tasks that are DONE count as delivered progress; open ones are listed without internal status detail
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, done: t.statusCategory === "DONE", dueAt: t.dueAt, completedAt: t.completedAt })),
      approvals: approvals.map((a) => ({ id: a.id, title: a.title, description: a.description, status: a.status, approverType: a.approverType, entityType: a.entityType, entityId: a.entityId, createdAt: a.createdAt, decidedAt: a.decidedAt, decisionComment: a.decisionComment, mine: a.approverType === "CLIENT" && (!a.approverUserId || a.approverUserId === ctx.userId) })),
      files: files.map((f) => ({ id: f.id, fileName: f.fileName, mimeType: f.mimeType, size: f.size, version: f.version, createdAt: f.createdAt, clientVisible: true, entityType: f.entityType, entityId: f.entityId })),
      requests: requests.map((c) => ({ id: c.id, title: c.title, description: c.description, status: c.status, response: c.response, createdAt: c.createdAt, mine: c.requestedById === ctx.userId })),
      delivery: dTotal > 0 ? { total: dTotal, delivered: d.DELIVERED ?? 0, inProgress: (d.ASSIGNED ?? 0) + (d.OUT_FOR_DELIVERY ?? 0) + (d.RESCHEDULED ?? 0), issues: (d.FAILED_ATTEMPT ?? 0) + (d.RETURNED ?? 0) } : null,
      rsvp: Object.keys(r).length ? { attending: r.ATTENDING ?? 0, declined: r.DECLINED ?? 0, maybe: r.MAYBE ?? 0, pending: r.NONE ?? 0 } : null,
      booths,
      changeOrders: changeOrders.map((c) => ({ id: c.id, code: c.code, title: c.title, description: c.description, amountDelta: Number(c.amountDelta), status: c.status })),
    };
  });
}

export async function createChangeRequest(ctx: ServiceContext, input: z.output<typeof changeRequestSchema>) {
  assertClient(ctx);
  return withTenant(scoped(ctx), async (tx) => {
    const s = await clientScope(tx, ctx, input.projectId);
    const c = await tx.changeRequest.create({ data: { ...input, organizationId: ctx.orgId, requestedById: ctx.userId } });
    await audit(tx, ctx, { action: "change_request.create", entityType: "CHANGE_REQUEST", entityId: c.id, projectId: input.projectId, summary: c.title });
    const managers = await tx.projectMember.findMany({ where: { projectId: input.projectId, role: "MANAGER" }, select: { userId: true } });
    await notify(tx, { orgId: ctx.orgId, userIds: [...managers.map((m) => m.userId), s.project.createdById], type: "change_request.created", titleKey: "notif.changeRequest", params: { title: c.title }, link: `/projects/${input.projectId}/approvals`, entityType: "CHANGE_REQUEST", entityId: c.id });
    return c;
  });
}

/** Agency side: respond to a client's change request. */
export async function respondChangeRequest(ctx: ServiceContext, input: z.output<typeof changeResponseSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    const c = await tx.changeRequest.findUnique({ where: { id: input.id } });
    if (!c) throw new NotFoundError();
    const s = await projectScope(tx, ctx, c.projectId);
    if (s.clientView || !s.manage) throw new ForbiddenError();
    if (["ACCEPTED", "DECLINED"].includes(c.status)) throw new ValidationError("errors.invalidTransition");
    if (input.status !== "UNDER_REVIEW" && !input.response?.trim()) throw new ValidationError("errors.validation", { response: ["common.required"] });
    const u = await tx.changeRequest.update({ where: { id: c.id }, data: { status: input.status, response: input.response ?? c.response, respondedById: ctx.userId } });
    await audit(tx, ctx, { action: "change_request.respond", entityType: "CHANGE_REQUEST", entityId: c.id, projectId: c.projectId, summary: `${c.status} → ${u.status}` });
    await notify(tx, { orgId: ctx.orgId, userIds: [c.requestedById], type: "change_request.responded", titleKey: "notif.changeRequestResponded", params: { title: c.title }, link: `/projects/${c.projectId}`, entityType: "CHANGE_REQUEST", entityId: c.id });
    return u;
  });
}

export async function listChangeRequests(ctx: ServiceContext, projectId: string) {
  return withTenant(scoped(ctx), async (tx) => {
    const s = await projectScope(tx, ctx, projectId);
    if (s.fieldOnly) throw new NotFoundError();
    const rows = await tx.changeRequest.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
    const users = await tx.user.findMany({ where: { id: { in: rows.map((r) => r.requestedById) } }, select: { id: true, name: true } });
    return { canRespond: s.manage && !s.clientView, rows: rows.map((r) => ({ ...r, requestedBy: users.find((u) => u.id === r.requestedById)?.name ?? "—" })) };
  });
}
