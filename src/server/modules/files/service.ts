import { createId } from "@/lib/id";
import { sha256Hex } from "@/server/auth/crypto";
import type { ServiceContext } from "@/server/authz/context";
import type { Prisma } from "@/generated/prisma/client";
import { can, projectScope, taskVisibilityWhere } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { maxUploadBytes, sniffMime, storage, tenantKey } from "./storage";

export interface UploadInput {
  projectId?: string | null;
  entityType: string;
  entityId: string;
  kind?: string;
  fileName: string;
  declaredType: string;
  body: Buffer;
  clientVisible?: boolean;
  /** replaces a previous attachment (new version in the chain) */
  previousId?: string | null;
}

/** Validates + stores a file and creates its Attachment row (caller provides the tx). */
export async function storeAttachment(tx: Tx, ctx: ServiceContext, input: UploadInput) {
  if (input.body.length === 0) throw new ValidationError("errors.fileType");
  if (input.body.length > maxUploadBytes()) throw new ValidationError("errors.fileTooLarge");
  const mime = sniffMime(input.body, input.declaredType, input.fileName);
  if (!mime) throw new ValidationError("errors.fileType");
  let version = 1;
  if (input.previousId) {
    const prev = await tx.attachment.findUnique({ where: { id: input.previousId } });
    if (!prev || prev.entityId !== input.entityId) throw new NotFoundError();
    version = prev.version + 1;
  }
  const id = createId();
  const key = tenantKey(ctx.orgId, input.entityType.toLowerCase(), id, input.fileName);
  await storage().put(key, input.body, mime);
  const att = await tx.attachment.create({
    data: {
      id,
      organizationId: ctx.orgId,
      projectId: input.projectId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      kind: input.kind ?? "FILE",
      storageKey: key,
      fileName: input.fileName.slice(0, 200),
      mimeType: mime,
      size: input.body.length,
      sha256: sha256Hex(input.body),
      version,
      previousId: input.previousId ?? null,
      clientVisible: input.clientVisible ?? false,
      uploadedById: ctx.userId,
    },
  });
  await audit(tx, ctx, { action: "file.upload", entityType: "ATTACHMENT", entityId: att.id, projectId: input.projectId, summary: `${input.fileName} → ${input.entityType}`, meta: { version, size: att.size } });
  return att;
}

/**
 * Authorizes access to one attachment for the caller. Rules mirror the parent record:
 * project scope required; clients only see clientVisible; field agents only their deliveries' evidence.
 */
export async function authorizeAttachment(ctx: ServiceContext, attachmentId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const att = await tx.attachment.findUnique({ where: { id: attachmentId } });
    if (!att || att.deletedAt) throw new NotFoundError();
    if (att.projectId) {
      const scope = await projectScope(tx, ctx, att.projectId);
      if (scope.clientView && !att.clientVisible) throw new NotFoundError();
      if (scope.fieldOnly) {
        if (att.entityType !== "DELIVERY") throw new NotFoundError();
        const d = await tx.delivery.findUnique({ where: { id: att.entityId }, select: { agentId: true } });
        if (d?.agentId !== ctx.userId) throw new NotFoundError();
      }
      if (att.entityType === "TASK") {
        // a file is as visible as its task: own/collaborated tasks for task-scoped people, allowed workstreams, client-visible tasks for clients
        const t = await tx.task.findFirst({ where: { ...(taskVisibilityWhere(ctx, scope) as Prisma.TaskWhereInput), id: att.entityId }, select: { id: true } });
        if (!t) throw new NotFoundError();
      }
      if (att.entityType === "DELIVERY" && !scope.fieldOnly && !can(ctx, "delivery.view")) throw new NotFoundError();
      if (att.entityType === "EXPENSE" && !scope.finance && att.uploadedById !== ctx.userId) throw new ForbiddenError();
      if (att.entityType === "IMPORT" && !can(ctx, "recipient.import")) throw new ForbiddenError();
    } else if (att.entityType === "VENDOR" && !can(ctx, "vendor.view")) {
      throw new ForbiddenError();
    } else if (att.entityType === "WORK_ORDER") {
      const w = await tx.workOrder.findUnique({ where: { id: att.entityId }, select: { vendorId: true, projectId: true } });
      if (!w) throw new NotFoundError();
      if (ctx.role === "VENDOR") {
        if (ctx.vendorId !== w.vendorId) throw new NotFoundError();
      } else {
        await projectScope(tx, ctx, w.projectId);
        if (!can(ctx, "vendor.view")) throw new ForbiddenError();
      }
    }
    return att;
  });
}

export async function signedUrlFor(ctx: ServiceContext, attachmentId: string, expiresIn = 300) {
  const att = await authorizeAttachment(ctx, attachmentId);
  await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    audit(tx, ctx, { action: "file.access", entityType: "ATTACHMENT", entityId: att.id, projectId: att.projectId }),
  );
  return storage().signedUrl(att.storageKey, { expiresIn, fileName: att.fileName, contentType: att.mimeType, attachmentId: att.id });
}

export async function listAttachments(ctx: ServiceContext, entityType: string, entityId: string, opts: { clientView?: boolean } = {}) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx.attachment.findMany({ where: { entityType, entityId, deletedAt: null, ...(opts.clientView ? { clientVisible: true } : {}) }, orderBy: [{ fileName: "asc" }, { version: "desc" }] }),
  );
}
