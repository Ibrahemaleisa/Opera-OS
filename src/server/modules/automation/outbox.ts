import type { Prisma } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import type { Tx } from "@/server/db/tenant";

export type DomainEventType =
  | "task.assigned"
  | "task.status_changed"
  | "task.overdue"
  | "task.due_soon"
  | "comment.mentioned"
  | "approval.requested"
  | "approval.decided"
  | "approval.rejected"
  | "milestone.blocked"
  | "delivery.failed"
  | "delivery.delivered"
  | "delivery.assigned"
  | "import.completed"
  | "import.failed"
  | "event.approaching"
  | "project.completed"
  | "incident.reported"
  | "campaign.approval_requested"
  | "member.invited";

/**
 * Transactional outbox: the event row commits atomically with the change that caused it.
 * The automation dispatcher (worker, or inline) processes unprocessed rows idempotently.
 */
export async function emit(tx: Tx, ctx: ServiceContext, type: DomainEventType, payload: Record<string, unknown>) {
  await tx.outboxEvent.create({
    data: { organizationId: ctx.orgId, type, payload: payload as Prisma.InputJsonValue, actorId: ctx.userId === "system" ? null : ctx.userId },
  });
}
