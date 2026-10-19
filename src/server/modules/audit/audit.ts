import type { Prisma } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import type { Tx } from "@/server/db/tenant";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  projectId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}

const REDACT = new Set(["passwordHash", "mobile", "altPhone", "email", "restrictedNotes", "address"]);

/** Strip sensitive values from audit payloads (keep the fact that they changed). */
function redact(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (k, v) => (REDACT.has(k) && v ? "[redacted]" : typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

/** Append-only audit event, written in the same transaction as the change it describes. */
export async function audit(tx: Tx, ctx: ServiceContext, input: AuditInput) {
  await tx.auditEvent.create({
    data: {
      organizationId: ctx.orgId,
      actorId: ctx.userId === "system" ? null : ctx.userId,
      actorName: ctx.userName,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      projectId: input.projectId ?? null,
      summary: input.summary?.slice(0, 500),
      before: redact(input.before),
      after: redact(input.after),
      meta: redact(input.meta),
      ip: ctx.request?.ip ?? null,
      userAgent: ctx.request?.userAgent?.slice(0, 300) ?? null,
    },
  });
}
