import { z } from "zod";
import type { Approval, ApprovalStatus, Prisma, Project, ProjectMember } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { can, computeProjectScope, projectScope, type ProjectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { emit } from "@/server/modules/automation/outbox";
import { notify } from "@/server/modules/notifications/notify";
import { DEFAULT_STATUSES, type StatusDef } from "@/server/modules/templates/definition";

export const ENTITY_TYPES = ["TASK", "DELIVERABLE", "DESIGN_REVISION", "CAMPAIGN", "PURCHASE_ORDER", "EXPENSE", "CHANGE_ORDER", "MILESTONE"] as const;
/** Entity types that may be routed through the generic "request approval" action. The others go through their module's own submit flow. */
export const GENERIC_ENTITY_TYPES = ["TASK", "DELIVERABLE", "MILESTONE"] as const;
/** Spend approvals: visible and decidable only with finance scope. */
export const FINANCIAL_ENTITY_TYPES = ["PURCHASE_ORDER", "EXPENSE", "CHANGE_ORDER"] as const;
const FINANCIAL = new Set<string>(FINANCIAL_ENTITY_TYPES);
/** Projects in these states are archived: their approvals can no longer be decided. */
export const INACTIVE_PROJECT_STATUSES = ["CLOSED", "CANCELLED", "COMPLETED"] as const;

export const requestInput = z.object({
  projectId: z.string(),
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).optional().nullable(),
  approverType: z.enum(["INTERNAL", "CLIENT"]).default("INTERNAL"),
  approverUserId: z.string().optional().nullable(),
  dueAt: z.coerce.date().optional().nullable(),
});

/** What the generic server action accepts (tasks, deliverables, milestones only). */
export const genericRequestInput = requestInput.extend({ entityType: z.enum(GENERIC_ENTITY_TYPES) });

function statusesOf(ws: { statuses: unknown } | null | undefined): StatusDef[] {
  const s = ws?.statuses as StatusDef[] | undefined;
  return Array.isArray(s) && s.length ? s : DEFAULT_STATUSES;
}

// ── Authority ──────────────────────────────────────────────────────────────

type ApprovalLike = Pick<Approval, "entityType" | "approverType" | "approverUserId" | "requestedById" | "clientVisible">;

/**
 * The single decide rule, shared by decideApproval, the approver-set resolution and
 * listApprovalsAwaitingDecision:
 *  - never the requester, and for financial items never the person who created/submitted the spend;
 *  - a designated approver narrows the set to that person — it never grants authority;
 *  - authority by type: client approvals → a client approver of the project's client;
 *    campaigns → campaign.approve; financial → finance.approve with finance visibility;
 *    tasks / deliverables / milestones / design revisions → project approve scope.
 */
export function mayDecide(actor: Pick<ServiceContext, "userId" | "permissions">, scope: ProjectScope | null, a: ApprovalLike, entityCreatorId: string | null): boolean {
  if (!scope || scope.fieldOnly) return false;
  if (a.requestedById === actor.userId) return false;
  if (a.approverUserId && a.approverUserId !== actor.userId) return false;
  if (a.approverType === "CLIENT") return scope.clientView && scope.approve && a.clientVisible;
  if (scope.clientView) return false;
  if (a.entityType === "CAMPAIGN") return can(actor as ServiceContext, "campaign.approve");
  if (FINANCIAL.has(a.entityType)) return can(actor as ServiceContext, "finance.approve") && scope.finance && entityCreatorId !== actor.userId;
  return scope.approve;
}

/** Who created / submitted a financial entity (segregation of duties is about who spent, not who clicked "submit"). */
async function entityCreator(tx: Tx, entityType: string, entityId: string): Promise<string | null> {
  if (entityType === "PURCHASE_ORDER") return (await tx.purchaseOrder.findUnique({ where: { id: entityId }, select: { createdById: true } }))?.createdById ?? null;
  if (entityType === "EXPENSE") return (await tx.expense.findUnique({ where: { id: entityId }, select: { submittedById: true } }))?.submittedById ?? null;
  if (entityType === "CHANGE_ORDER") return (await tx.changeOrder.findUnique({ where: { id: entityId }, select: { createdById: true } }))?.createdById ?? null;
  return null;
}

interface Candidate {
  ctx: ServiceContext;
  member: ProjectMember | null;
}

/** Active members of the org as lightweight contexts, so the same policy functions can be evaluated for them. */
async function candidates(tx: Tx, orgId: string, projectId: string): Promise<Candidate[]> {
  const [memberships, pms] = await Promise.all([
    tx.membership.findMany({ where: { organizationId: orgId, status: "ACTIVE" }, include: { role: true } }),
    tx.projectMember.findMany({ where: { projectId } }),
  ]);
  return memberships.map((m) => ({
    member: pms.find((p) => p.userId === m.userId) ?? null,
    ctx: {
      userId: m.userId, userName: "", locale: "ar", orgId, orgSlug: "", orgName: "", membershipId: m.id, role: m.role.baseRole, roleKey: m.role.key,
      clientId: m.clientId, vendorId: m.vendorId, permissions: new Set(m.role.permissions), isPlatformAdmin: false,
    },
  }));
}

function scopeFor(c: Candidate, project: Project): ProjectScope | null {
  try {
    return computeProjectScope(c.ctx, project, c.member);
  } catch {
    return null;
  }
}

/**
 * The approver set at request time: everyone who could decide this approval right now (empty → the
 * request is refused). `notify` is who gets told: for project work (tasks, deliverables, milestones,
 * revisions) the eligible project members, falling back to everyone eligible (ops directors, owners).
 */
export async function resolveApproverSet(tx: Tx, project: Project, a: ApprovalLike & { entityId: string }): Promise<{ eligible: string[]; notify: string[] }> {
  const creator = await entityCreator(tx, a.entityType, a.entityId);
  const all = await candidates(tx, project.organizationId, project.id);
  const ok = all.filter((c) => mayDecide(c.ctx, scopeFor(c, project), a, creator));
  const eligible = ok.map((c) => c.ctx.userId);
  const projectWork = a.approverType === "INTERNAL" && a.entityType !== "CAMPAIGN" && !FINANCIAL.has(a.entityType);
  const members = ok.filter((c) => c.member).map((c) => c.ctx.userId);
  return { eligible, notify: projectWork && members.length ? members : eligible };
}

// ── Request ────────────────────────────────────────────────────────────────

/** Loads the entity, checks it belongs to the project and is in a state that can be submitted. */
async function assertEntityRequestable(tx: Tx, entityType: string, entityId: string, projectId: string) {
  const found =
    entityType === "TASK" ? await tx.task.findFirst({ where: { id: entityId, projectId }, select: { statusCategory: true } }).then((t) => t && { ok: !["DONE", "CANCELLED"].includes(t.statusCategory) })
    : entityType === "DELIVERABLE" ? await tx.deliverable.findFirst({ where: { id: entityId, projectId }, select: { status: true } }).then((d) => d && { ok: d.status !== "APPROVED" })
    : entityType === "MILESTONE" ? await tx.milestone.findFirst({ where: { id: entityId, projectId }, select: { status: true } }).then((m) => m && { ok: m.status !== "DONE" })
    : entityType === "DESIGN_REVISION" ? await tx.designRevision.findFirst({ where: { id: entityId, booth: { projectId } }, select: { status: true } }).then((r) => r && { ok: ["DRAFT", "REJECTED"].includes(r.status) })
    : entityType === "CAMPAIGN" ? await tx.invitationCampaign.findFirst({ where: { id: entityId, projectId }, select: { status: true } }).then((c) => c && { ok: c.status === "DRAFT" })
    : entityType === "PURCHASE_ORDER" ? await tx.purchaseOrder.findFirst({ where: { id: entityId, projectId }, select: { status: true } }).then((p) => p && { ok: p.status === "DRAFT" })
    : entityType === "EXPENSE" ? await tx.expense.findFirst({ where: { id: entityId, projectId }, select: { status: true } }).then((e) => e && { ok: e.status === "SUBMITTED" })
    : entityType === "CHANGE_ORDER" ? await tx.changeOrder.findFirst({ where: { id: entityId, projectId }, select: { status: true, approvalId: true } }).then((c) => c && { ok: c.status === "PENDING" })
    : null;
  if (!found) throw new NotFoundError();
  if (!found.ok) throw new ValidationError("errors.invalidTransition");
}

/** Creates an approval request inside an existing transaction (used by other modules too). */
export async function requestApprovalTx(tx: Tx, ctx: ServiceContext, input: z.output<typeof requestInput>) {
  // serialise requests per entity so a double submit cannot open two pending approvals
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`approval:${input.entityType}:${input.entityId}`}))`;
  await assertEntityRequestable(tx, input.entityType, input.entityId, input.projectId);
  const open = await tx.approval.findFirst({ where: { entityType: input.entityType, entityId: input.entityId, status: "PENDING" } });
  if (open) throw new ConflictError();
  const project = await tx.project.findUniqueOrThrow({ where: { id: input.projectId } });
  if ((INACTIVE_PROJECT_STATUSES as readonly string[]).includes(project.status)) throw new ValidationError("errors.projectInactive");
  const like = { entityType: input.entityType, entityId: input.entityId, approverType: input.approverType, approverUserId: input.approverUserId ?? null, requestedById: ctx.userId, clientVisible: input.approverType === "CLIENT" };
  const { eligible: approvers, notify: notifyIds } = await resolveApproverSet(tx, project, like);
  if (!approvers.length) {
    // a named approver who can't decide is a different mistake than "nobody can decide"
    if (input.approverUserId) throw new ValidationError("errors.validation", { approverUserId: ["errors.approverNotEligible"] });
    throw new ValidationError("errors.noEligibleApprover");
  }
  const a = await tx.approval.create({
    data: { ...input, organizationId: ctx.orgId, requestedById: ctx.userId, clientVisible: input.approverType === "CLIENT" },
  });
  await tx.approvalDecision.create({ data: { organizationId: ctx.orgId, approvalId: a.id, decision: "PENDING", actorId: ctx.userId, comment: input.description ?? null } });
  if (input.entityType === "DELIVERABLE") await tx.deliverable.update({ where: { id: input.entityId }, data: { status: "SUBMITTED" } });
  if (input.entityType === "DESIGN_REVISION") await tx.designRevision.update({ where: { id: input.entityId }, data: { status: "SUBMITTED", approvalId: a.id } });
  if (input.entityType === "CAMPAIGN") await tx.invitationCampaign.update({ where: { id: input.entityId }, data: { status: "PENDING_APPROVAL" } });
  if (input.entityType === "PURCHASE_ORDER") await tx.purchaseOrder.update({ where: { id: input.entityId }, data: { status: "PENDING_APPROVAL", approvalId: a.id } });
  if (input.entityType === "CHANGE_ORDER") await tx.changeOrder.update({ where: { id: input.entityId }, data: { approvalId: a.id } });
  await audit(tx, ctx, { action: "approval.request", entityType: input.entityType, entityId: input.entityId, projectId: input.projectId, summary: input.title, meta: { approvalId: a.id, approverType: input.approverType, approvers: approvers.length } });
  await emit(tx, ctx, "approval.requested", {
    approvalId: a.id, projectId: input.projectId, approverUserId: input.approverUserId ?? null, approverUserIds: notifyIds, requestedById: ctx.userId, title: input.title,
    entityType: input.entityType, entityId: input.entityId, link: `/projects/${input.projectId}/approvals`,
  });
  return a;
}

/** Generic request (task / deliverable / milestone). Finance, campaigns and design revisions use their own submit flows. */
export async function requestApproval(ctx: ServiceContext, input: z.output<typeof requestInput>) {
  if (!(GENERIC_ENTITY_TYPES as readonly string[]).includes(input.entityType)) throw new ValidationError("errors.validation", { entityType: ["errors.invalidTransition"] });
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.operate || scope.clientView) throw new ForbiddenError();
    if (!can(ctx, "approval.request") && !scope.manage) throw new ForbiddenError();
    return requestApprovalTx(tx, ctx, input);
  });
}

// ── Decide ─────────────────────────────────────────────────────────────────

export const decideInput = z.object({ approvalId: z.string(), decision: z.enum(["APPROVED", "REJECTED"]), comment: z.string().trim().max(4000).optional().nullable() });

export async function decideApproval(ctx: ServiceContext, input: z.output<typeof decideInput>) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const a = await tx.approval.findUnique({ where: { id: input.approvalId } });
    if (!a) throw new NotFoundError();
    const scope = await projectScope(tx, ctx, a.projectId);
    if (a.approverType === "INTERNAL" && scope.clientView) throw new NotFoundError();
    if (!mayDecide(ctx, scope, a, await entityCreator(tx, a.entityType, a.entityId))) throw new ForbiddenError();
    if (a.status !== "PENDING") throw new ConflictError();
    if ((INACTIVE_PROJECT_STATUSES as readonly string[]).includes(scope.project.status)) throw new ValidationError("errors.projectInactive");
    if (input.decision === "REJECTED" && !input.comment) throw new ValidationError("errors.validation", { comment: ["common.required"] });
    // compare-and-set on PENDING so two approvers can't both decide
    const res = await tx.approval.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: input.decision, decidedById: ctx.userId, decidedAt: new Date(), decisionComment: input.comment ?? null } });
    if (!res.count) throw new ConflictError();
    await tx.approvalDecision.create({ data: { organizationId: ctx.orgId, approvalId: a.id, decision: input.decision, comment: input.comment ?? null, actorId: ctx.userId } });
    await applyDecision(tx, a.entityType, a.entityId, input.decision, ctx.userId);
    await audit(tx, ctx, { action: `approval.${input.decision.toLowerCase()}`, entityType: a.entityType, entityId: a.entityId, projectId: a.projectId, summary: a.title, meta: { approvalId: a.id, comment: input.comment } });
    const payload = { approvalId: a.id, projectId: a.projectId, requestedById: a.requestedById, status: input.decision, title: a.title, entityType: a.entityType, entityId: a.entityId, link: a.entityType === "TASK" ? `/tasks/${a.entityId}` : `/projects/${a.projectId}/approvals` };
    await emit(tx, ctx, "approval.decided", payload);
    if (input.decision === "REJECTED") await emit(tx, ctx, "approval.rejected", payload);
    return tx.approval.findUniqueOrThrow({ where: { id: a.id } });
  });
}

/** Applies a decision to its entity with a compare-and-set on the state the request put it in; a changed entity makes the decision stale. */
async function applyDecision(tx: Tx, entityType: string, entityId: string, decision: ApprovalStatus, actorId: string) {
  const approved = decision === "APPROVED";
  const cas = async (p: Promise<{ count: number }>) => {
    if (!(await p).count) throw new ConflictError("errors.approvalStale");
  };
  switch (entityType) {
    case "TASK": {
      if (!approved) return; // reopen handled by automation rule (approval.rejected → reopen_entity)
      const t = await tx.task.findUnique({ where: { id: entityId }, include: { workstream: true } });
      if (!t || ["DONE", "CANCELLED"].includes(t.statusCategory)) throw new ConflictError("errors.approvalStale");
      if (t.statusCategory !== "REVIEW") return; // approval recorded; the owner completes it
      const openDeps = await tx.taskDependency.count({ where: { taskId: t.id, dependsOn: { statusCategory: { notIn: ["DONE", "CANCELLED"] } } } });
      const done = statusesOf(t.workstream).find((s) => s.category === "DONE");
      if (done && !openDeps) await tx.task.updateMany({ where: { id: entityId, statusCategory: "REVIEW" }, data: { status: done.key, statusCategory: "DONE", completedAt: new Date(), version: { increment: 1 } } });
      return;
    }
    case "DELIVERABLE":
      return cas(tx.deliverable.updateMany({ where: { id: entityId, status: "SUBMITTED" }, data: { status: approved ? "APPROVED" : "REJECTED" } }));
    case "MILESTONE":
      if (approved) await cas(tx.milestone.updateMany({ where: { id: entityId, status: { not: "DONE" } }, data: { status: "DONE", completedAt: new Date() } }));
      return;
    case "DESIGN_REVISION": {
      await cas(tx.designRevision.updateMany({ where: { id: entityId, status: "SUBMITTED" }, data: { status: approved ? "APPROVED" : "REJECTED" } }));
      const rev = await tx.designRevision.findUniqueOrThrow({ where: { id: entityId } });
      if (approved) {
        await tx.designRevision.updateMany({ where: { boothId: rev.boothId, id: { not: rev.id }, status: "APPROVED" }, data: { status: "SUPERSEDED" } });
        await tx.booth.updateMany({ where: { id: rev.boothId, stage: { in: ["BRIEF", "DESIGN", "CLIENT_APPROVAL"] } }, data: { stage: "PROCUREMENT" } });
      } else {
        await tx.booth.updateMany({ where: { id: rev.boothId, stage: "CLIENT_APPROVAL" }, data: { stage: "DESIGN" } });
      }
      return;
    }
    case "CAMPAIGN":
      return cas(tx.invitationCampaign.updateMany({ where: { id: entityId, status: "PENDING_APPROVAL" }, data: approved ? { status: "APPROVED", approvedById: actorId, approvedAt: new Date() } : { status: "DRAFT" } }));
    case "PURCHASE_ORDER":
      return cas(tx.purchaseOrder.updateMany({ where: { id: entityId, status: "PENDING_APPROVAL" }, data: { status: approved ? "APPROVED" : "DRAFT" } }));
    case "EXPENSE":
      return cas(tx.expense.updateMany({ where: { id: entityId, status: "SUBMITTED" }, data: approved ? { status: "APPROVED", approvedById: actorId, approvedAt: new Date() } : { status: "REJECTED" } }));
    case "CHANGE_ORDER":
      return cas(tx.changeOrder.updateMany({ where: { id: entityId, status: "PENDING" }, data: { status: decision } }));
  }
}

// ── Withdraw / cancel / supersede ──────────────────────────────────────────

/** Puts an entity back into the state it had before the request (withdrawn / re-routed approvals). */
async function revertEntity(tx: Tx, a: Approval) {
  if (a.entityType === "DELIVERABLE") await tx.deliverable.updateMany({ where: { id: a.entityId, status: "SUBMITTED" }, data: { status: "IN_PROGRESS" } });
  if (a.entityType === "DESIGN_REVISION") await tx.designRevision.updateMany({ where: { id: a.entityId, status: "SUBMITTED" }, data: { status: "DRAFT", approvalId: null } });
  if (a.entityType === "CAMPAIGN") await tx.invitationCampaign.updateMany({ where: { id: a.entityId, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } });
  if (a.entityType === "PURCHASE_ORDER") await tx.purchaseOrder.updateMany({ where: { id: a.entityId, status: "PENDING_APPROVAL" }, data: { status: "DRAFT", approvalId: null } });
  if (a.entityType === "CHANGE_ORDER") await tx.changeOrder.updateMany({ where: { id: a.entityId, status: "PENDING", approvalId: a.id }, data: { approvalId: null } });
}

/**
 * Closes PENDING approvals of an entity (or a given list) as CANCELLED with a reason, audited,
 * telling the requester. `revert` puts the entity back to its pre-request state (withdraw / re-route);
 * leave it off when the entity itself is being cancelled or changed.
 */
export async function cancelPendingApprovalsTx(tx: Tx, ctx: ServiceContext, where: Prisma.ApprovalWhereInput, opts: { reason: string; revert?: boolean; action?: string }) {
  const pending = await tx.approval.findMany({ where: { ...where, status: "PENDING" } });
  for (const a of pending) {
    const r = await tx.approval.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: "CANCELLED", decidedById: ctx.userId === "system" ? null : ctx.userId, decidedAt: new Date(), decisionComment: opts.reason.slice(0, 4000) } });
    if (!r.count) continue;
    await tx.approvalDecision.create({ data: { organizationId: ctx.orgId, approvalId: a.id, decision: "CANCELLED", comment: opts.reason.slice(0, 4000), actorId: ctx.userId } });
    if (opts.revert) await revertEntity(tx, a);
    await audit(tx, ctx, { action: opts.action ?? "approval.cancel", entityType: a.entityType, entityId: a.entityId, projectId: a.projectId, summary: a.title, meta: { approvalId: a.id, reason: opts.reason } });
    await notify(tx, { orgId: ctx.orgId, userIds: [a.requestedById, a.approverUserId], type: "approval.cancelled", titleKey: "tasks.approvalNotices.cancelled", params: { title: a.title }, link: `/projects/${a.projectId}/approvals`, entityType: a.entityType, entityId: a.entityId, excludeUserId: ctx.userId });
  }
  return pending.length;
}

export const withdrawInput = z.object({ approvalId: z.string(), reason: z.string().trim().min(3).max(1000) });

/** The requester (or a project manager) withdraws a PENDING request; the entity returns to its pre-request state. */
export async function withdrawApproval(ctx: ServiceContext, input: z.output<typeof withdrawInput>) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const a = await tx.approval.findUnique({ where: { id: input.approvalId } });
    if (!a) throw new NotFoundError();
    const scope = await projectScope(tx, ctx, a.projectId);
    if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
    if (a.requestedById !== ctx.userId && !scope.manage) throw new ForbiddenError();
    if (a.status !== "PENDING") throw new ConflictError("errors.approvalStale");
    await cancelPendingApprovalsTx(tx, ctx, { id: a.id }, { reason: input.reason, revert: true, action: "approval.withdraw" });
    return tx.approval.findUniqueOrThrow({ where: { id: a.id } });
  });
}

/**
 * An APPROVED decision stops covering an entity once the entity is reopened/changed: it becomes
 * SUPERSEDED (audited) and the decider (and, for client approvals, the client) is told.
 */
export async function supersedeApprovalsTx(tx: Tx, ctx: ServiceContext, entityType: string, entityId: string, reason: string) {
  const approved = await tx.approval.findMany({ where: { entityType, entityId, status: "APPROVED" } });
  for (const a of approved) {
    await tx.approval.update({ where: { id: a.id }, data: { status: "SUPERSEDED" } });
    await tx.approvalDecision.create({ data: { organizationId: ctx.orgId, approvalId: a.id, decision: "SUPERSEDED", comment: reason.slice(0, 4000), actorId: ctx.userId } });
    await audit(tx, ctx, { action: "approval.superseded", entityType, entityId, projectId: a.projectId, summary: a.title, meta: { approvalId: a.id, reason } });
    await notify(tx, { orgId: ctx.orgId, userIds: [a.decidedById, a.approverUserId, a.requestedById], type: "approval.superseded", titleKey: "tasks.approvalNotices.superseded", params: { title: a.title }, link: entityType === "TASK" ? `/tasks/${entityId}` : `/projects/${a.projectId}/approvals`, entityType, entityId, excludeUserId: ctx.userId });
  }
  return approved.length;
}

// ── Queries ────────────────────────────────────────────────────────────────

export async function listProjectApprovals(ctx: ServiceContext, projectId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (scope.fieldOnly) throw new NotFoundError();
    const approvals = await tx.approval.findMany({
      // spend approvals only with finance scope, like the rest of the project's money
      where: { projectId, ...(scope.clientView ? { clientVisible: true } : {}), ...(scope.finance ? {} : { entityType: { notIn: [...FINANCIAL_ENTITY_TYPES] } }) },
      include: { decisions: { orderBy: { createdAt: "asc" } } },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });
    const userIds = [...new Set(approvals.flatMap((a) => [a.requestedById, a.decidedById, a.approverUserId, ...a.decisions.map((d) => d.actorId)]).filter((x): x is string => !!x))];
    const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, nameAr: true } });
    const creators = new Map<string, string | null>();
    for (const a of approvals.filter((x) => x.status === "PENDING" && FINANCIAL.has(x.entityType))) creators.set(a.id, await entityCreator(tx, a.entityType, a.entityId));
    const active = !(INACTIVE_PROJECT_STATUSES as readonly string[]).includes(scope.project.status);
    return {
      approvals: approvals.map((a) => ({
        ...a,
        canDecide: a.status === "PENDING" && active && mayDecide(ctx, scope, a, creators.get(a.id) ?? null),
        canWithdraw: a.status === "PENDING" && !scope.clientView && (a.requestedById === ctx.userId || scope.manage),
      })),
      users: Object.fromEntries(users.map((u) => [u.id, (ctx.locale === "ar" ? u.nameAr : null) ?? u.name])),
      scope: { approve: scope.approve, clientView: scope.clientView, manage: scope.manage },
    };
  });
}

export interface AwaitingDecision {
  id: string;
  projectId: string;
  projectName: string;
  projectCode: string;
  entityType: string;
  entityId: string;
  title: string;
  approverType: "INTERNAL" | "CLIENT";
  requestedAt: Date;
  dueAt: Date | null;
  requestedByName: string | null;
  designatedToMe: boolean;
}

/**
 * PENDING approvals in active projects that the caller may decide right now — the same rule as
 * decideApproval (mayDecide) — oldest first.
 */
export async function listApprovalsAwaitingDecision(ctx: ServiceContext, opts?: { limit?: number }): Promise<AwaitingDecision[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const pending = await tx.approval.findMany({
      where: { status: "PENDING", requestedById: { not: ctx.userId }, OR: [{ approverUserId: null }, { approverUserId: ctx.userId }] },
      orderBy: { createdAt: "asc" },
      take: 1000,
    });
    if (!pending.length) return [];
    const projectIds = [...new Set(pending.map((a) => a.projectId))];
    const [projects, members] = await Promise.all([
      tx.project.findMany({ where: { id: { in: projectIds }, status: { notIn: [...INACTIVE_PROJECT_STATUSES] } } }),
      tx.projectMember.findMany({ where: { projectId: { in: projectIds }, userId: ctx.userId } }),
    ]);
    const scopes = new Map<string, ProjectScope | null>();
    for (const p of projects) {
      try {
        scopes.set(p.id, computeProjectScope(ctx, p, members.find((m) => m.projectId === p.id) ?? null));
      } catch {
        scopes.set(p.id, null);
      }
    }
    const out: (typeof pending)[number][] = [];
    for (const a of pending) {
      const scope = scopes.get(a.projectId);
      if (!scope) continue;
      const creator = FINANCIAL.has(a.entityType) ? await entityCreator(tx, a.entityType, a.entityId) : null;
      if (mayDecide(ctx, scope, a, creator)) out.push(a);
      if (out.length >= limit) break;
    }
    const users = await tx.user.findMany({ where: { id: { in: [...new Set(out.map((a) => a.requestedById))] } }, select: { id: true, name: true, nameAr: true } });
    const pmap = new Map(projects.map((p) => [p.id, p]));
    return out.map((a) => {
      const p = pmap.get(a.projectId)!;
      const u = users.find((x) => x.id === a.requestedById);
      return {
        id: a.id, projectId: a.projectId, projectName: (ctx.locale === "en" && p.nameEn) || p.name, projectCode: p.code, entityType: a.entityType, entityId: a.entityId, title: a.title,
        approverType: a.approverType, requestedAt: a.createdAt, dueAt: a.dueAt, requestedByName: u ? (ctx.locale === "ar" ? u.nameAr : null) ?? u.name : null, designatedToMe: a.approverUserId === ctx.userId,
      };
    });
  });
}
