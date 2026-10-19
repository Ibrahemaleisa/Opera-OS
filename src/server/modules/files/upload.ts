import type { ServiceContext } from "@/server/authz/context";
import { can, projectScope } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { storeAttachment } from "./service";

interface Input {
  entityType: string;
  entityId: string;
  kind?: string;
  clientVisible?: boolean;
  previousId?: string | null;
  fileName: string;
  declaredType: string;
  body: Buffer;
}

/** Resolves the parent record, checks the caller may attach to it, then stores the file. */
export async function uploadForEntity(ctx: ServiceContext, input: Input) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    let projectId: string | null = null;
    switch (input.entityType) {
      case "TASK": {
        const t = await tx.task.findUnique({ where: { id: input.entityId } });
        if (!t) throw new NotFoundError();
        const s = await projectScope(tx, ctx, t.projectId);
        if (s.clientView || s.fieldOnly || (s.taskScope === "assigned" && t.ownerId !== ctx.userId) || !s.operate) throw new ForbiddenError();
        projectId = t.projectId;
        break;
      }
      case "PROJECT": {
        const s = await projectScope(tx, ctx, input.entityId);
        if (!s.operate || s.clientView) throw new ForbiddenError();
        projectId = input.entityId;
        break;
      }
      case "DELIVERY": {
        const d = await tx.delivery.findUnique({ where: { id: input.entityId } });
        if (!d) throw new NotFoundError();
        const s = await projectScope(tx, ctx, d.projectId);
        const isAgent = s.fieldOnly && d.agentId === ctx.userId && can(ctx, "delivery.field");
        if (!isAgent && !can(ctx, "delivery.update")) throw new ForbiddenError();
        projectId = d.projectId;
        input.kind ??= "EVIDENCE";
        break;
      }
      case "BOOTH":
      case "REVISION": {
        const boothId = input.entityType === "BOOTH" ? input.entityId : (await tx.designRevision.findUnique({ where: { id: input.entityId } }))?.boothId;
        const b = boothId ? await tx.booth.findUnique({ where: { id: boothId } }) : null;
        if (!b) throw new NotFoundError();
        const s = await projectScope(tx, ctx, b.projectId);
        if (!can(ctx, "booth.manage") || s.clientView) throw new ForbiddenError();
        projectId = b.projectId;
        break;
      }
      case "EXPENSE": {
        const e = await tx.expense.findUnique({ where: { id: input.entityId } });
        if (!e) throw new NotFoundError();
        const s = await projectScope(tx, ctx, e.projectId);
        if (!s.finance && e.submittedById !== ctx.userId) throw new ForbiddenError();
        if (e.status !== "SUBMITTED" && e.status !== "REJECTED") throw new ValidationError("errors.invalidTransition"); // evidence is frozen once approved
        projectId = e.projectId;
        input.clientVisible = false;
        break;
      }
      case "VENDOR": {
        if (!can(ctx, "vendor.manage")) throw new ForbiddenError();
        if (!(await tx.vendor.findUnique({ where: { id: input.entityId } }))) throw new NotFoundError();
        input.clientVisible = false;
        break;
      }
      case "WORK_ORDER": {
        const w = await tx.workOrder.findUnique({ where: { id: input.entityId } });
        if (!w) throw new NotFoundError();
        if (ctx.role === "VENDOR") {
          if (!can(ctx, "vendor.portal") || ctx.vendorId !== w.vendorId) throw new NotFoundError();
        } else {
          const s = await projectScope(tx, ctx, w.projectId);
          if (!can(ctx, "vendor.manage") || !s.operate) throw new ForbiddenError();
        }
        // stored without a project so vendor users (not project members) can reach their own files
        input.clientVisible = false;
        break;
      }
      case "CAMPAIGN": {
        const c = await tx.invitationCampaign.findUnique({ where: { id: input.entityId } });
        if (!c) throw new NotFoundError();
        await projectScope(tx, ctx, c.projectId);
        if (!can(ctx, "campaign.manage")) throw new ForbiddenError();
        projectId = c.projectId;
        input.kind = "INVITATION_ASSET";
        break;
      }
      default:
        throw new ValidationError("errors.validation");
    }
    return storeAttachment(tx, ctx, { ...input, projectId });
  });
}
