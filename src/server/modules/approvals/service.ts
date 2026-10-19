import { z } from "zod";
import type { ApprovalStatus } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { can, projectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { emit } from "@/server/modules/automation/outbox";
import { statusesOf } from "@/server/modules/tasks/service";

export const ENTITY_TYPES = ["TASK", "DELIVERABLE", "DESIGN_REVISION", "CAMPAIGN", "PURCHASE_ORDER", "EXPENSE", "CHANGE_ORDER", "MILESTONE"] as const;
const FINANCIAL = new Set(["PURCHASE_ORDER", "EXPENSE", "CHANGE_ORDER"]);

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

async function assertEntityInProject(tx: Tx, entityType: string, entityId: string, projectId: string) {
  const found =
    entityType === "TASK" ? await tx.task.findFirst({ where: { id: entityId, projectId } })
    : entityType === "DELIVERABLE" ? await tx.deliverable.findFirst({ where: { id: entityId, projectId } })
    : entityType === "MILESTONE" ? await tx.milestone.findFirst({ where: { id: entityId, projectId } })
    : entityType === "DESIGN_REVISION" ? await tx.designRevision.findFirst({ where: { id: entityId, booth: { projectId } } })
    : entityType === "CAMPAIGN" ? await tx.invitationCampaign.findFirst({ where: { id: entityId, projectId } })
    : entityType === "PURCHASE_ORDER" ? await tx.purchaseOrder.findFirst({ where: { id: entityId, projectId } })
    : entityType === "EXPENSE" ? await tx.expense.findFirst({ where: { id: entityId, projectId } })
    : entityType === "CHANGE_ORDER" ? await tx.changeOrder.findFirst({ where: { id: entityId, projectId } })
    : null;
  if (!found) throw new NotFoundError();
}

/** Creates an approval request inside an existing transaction (used by other modules too). */
export async function requestApprovalTx(tx: Tx, ctx: ServiceContext, input: z.output<typeof requestInput>) {
  await assertEntityInProject(tx, input.entityType, input.entityId, input.projectId);
  const open = await tx.approval.findFirst({ where: { entityType: input.entityType, entityId: input.entityId, status: "PENDING" } });
  if (open) throw new ConflictError();
  if (input.approverUserId) {
    const pm = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId: input.projectId, userId: input.approverUserId } } });
    const m = await tx.membership.findFirst({ where: { userId: input.approverUserId, status: "ACTIVE" }, include: { role: true } });
    if (!m) throw new ValidationError("errors.validation", { approverUserId: ["errors.notFound"] });
    if (input.approverType === "CLIENT" && (m.role.baseRole !== "CLIENT_APPROVER" || !pm)) throw new ValidationError("errors.validation", { approverUserId: ["errors.forbidden"] });
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
  await audit(tx, ctx, { action: "approval.request", entityType: input.entityType, entityId: input.entityId, projectId: input.projectId, summary: input.title, meta: { approvalId: a.id, approverType: input.approverType } });
  await emit(tx, ctx, "approval.requested", { approvalId: a.id, projectId: input.projectId, approverUserId: input.approverUserId ?? null, requestedById: ctx.userId, title: input.title, entityType: input.entityType, entityId: input.entityId, link: input.approverType === "CLIENT" ? `/projects/${input.projectId}/approvals` : `/projects/${input.projectId}/approvals` });
  return a;
}

export async function requestApproval(ctx: ServiceContext, input: z.output<typeof requestInput>) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.operate || scope.clientView) throw new ForbiddenError();
    if (!can(ctx, "approval.request") && !scope.manage) throw new ForbiddenError();
    return requestApprovalTx(tx, ctx, input);
  });
}

export const decideInput = z.object({ approvalId: z.string(), decision: z.enum(["APPROVED", "REJECTED"]), comment: z.string().trim().max(4000).optional().nullable() });

export async function decideApproval(ctx: ServiceContext, input: z.output<typeof decideInput>) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const a = await tx.approval.findUnique({ where: { id: input.approvalId } });
    if (!a) throw new NotFoundError();
    const scope = await projectScope(tx, ctx, a.projectId);
    // authority
    if (a.approverType === "CLIENT") {
      if (!scope.clientView || !scope.approve || !a.clientVisible) throw new ForbiddenError();
      if (a.approverUserId && a.approverUserId !== ctx.userId) throw new ForbiddenError();
    } else {
      if (scope.clientView) throw new NotFoundError();
      const designated = a.approverUserId === ctx.userId;
      if (!designated && !scope.approve && !(a.entityType === "CAMPAIGN" && can(ctx, "campaign.approve"))) throw new ForbiddenError();
      if (a.entityType === "CAMPAIGN") {
        // bulk outbound messaging: dedicated permission + four-eyes principle
        if (!can(ctx, "campaign.approve") || a.requestedById === ctx.userId) throw new ForbiddenError();
      }
      if (FINANCIAL.has(a.entityType)) {
        if (!can(ctx, "finance.approve")) throw new ForbiddenError();
        if (a.requestedById === ctx.userId) throw new ForbiddenError(); // segregation of duties
      }
    }
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

async function applyDecision(tx: Tx, entityType: string, entityId: string, decision: ApprovalStatus, actorId: string) {
  const approved = decision === "APPROVED";
  switch (entityType) {
    case "TASK": {
      if (!approved) return; // reopen handled by automation rule (approval.rejected → reopen_entity)
      const t = await tx.task.findUnique({ where: { id: entityId }, include: { workstream: true } });
      if (t && t.statusCategory === "REVIEW") {
        const done = statusesOf(t.workstream).find((s) => s.category === "DONE");
        if (done) await tx.task.update({ where: { id: entityId }, data: { status: done.key, statusCategory: "DONE", completedAt: new Date(), version: { increment: 1 } } });
      }
      return;
    }
    case "DELIVERABLE":
      await tx.deliverable.update({ where: { id: entityId }, data: { status: approved ? "APPROVED" : "REJECTED" } });
      return;
    case "MILESTONE":
      if (approved) await tx.milestone.update({ where: { id: entityId }, data: { status: "DONE", completedAt: new Date() } });
      return;
    case "DESIGN_REVISION": {
      const rev = await tx.designRevision.update({ where: { id: entityId }, data: { status: approved ? "APPROVED" : "REJECTED" } });
      if (approved) {
        await tx.designRevision.updateMany({ where: { boothId: rev.boothId, id: { not: rev.id }, status: "APPROVED" }, data: { status: "SUPERSEDED" } });
        await tx.booth.updateMany({ where: { id: rev.boothId, stage: { in: ["BRIEF", "DESIGN", "CLIENT_APPROVAL"] } }, data: { stage: "PROCUREMENT" } });
      } else {
        await tx.booth.updateMany({ where: { id: rev.boothId, stage: "CLIENT_APPROVAL" }, data: { stage: "DESIGN" } });
      }
      return;
    }
    case "CAMPAIGN":
      await tx.invitationCampaign.update({ where: { id: entityId }, data: approved ? { status: "APPROVED", approvedById: actorId, approvedAt: new Date() } : { status: "DRAFT" } });
      return;
    case "PURCHASE_ORDER":
      await tx.purchaseOrder.update({ where: { id: entityId }, data: { status: approved ? "APPROVED" : "DRAFT" } });
      return;
    case "EXPENSE":
      await tx.expense.update({ where: { id: entityId }, data: approved ? { status: "APPROVED", approvedById: actorId, approvedAt: new Date() } : { status: "REJECTED" } });
      return;
    case "CHANGE_ORDER":
      await tx.changeOrder.update({ where: { id: entityId }, data: { status: decision } });
      return;
  }
}

export async function listProjectApprovals(ctx: ServiceContext, projectId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (scope.fieldOnly) throw new NotFoundError();
    const approvals = await tx.approval.findMany({
      where: { projectId, ...(scope.clientView ? { clientVisible: true } : {}) },
      include: { decisions: { orderBy: { createdAt: "asc" } } },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });
    const userIds = [...new Set(approvals.flatMap((a) => [a.requestedById, a.decidedById, a.approverUserId, ...a.decisions.map((d) => d.actorId)]).filter((x): x is string => !!x))];
    const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, nameAr: true } });
    return { approvals, users: Object.fromEntries(users.map((u) => [u.id, (ctx.locale === "ar" ? u.nameAr : null) ?? u.name])), scope: { approve: scope.approve, clientView: scope.clientView, manage: scope.manage } };
  });
}
