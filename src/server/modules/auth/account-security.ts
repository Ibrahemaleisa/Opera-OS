import { systemContext, type ServiceContext } from "@/server/authz/context";
import { withTenant, withUser } from "@/server/db/tenant";
import { audit } from "@/server/modules/audit/audit";
import type { SessionMeta } from "@/server/auth/session-store";

/**
 * Account-level security events (password reset, MFA) belong to the person, not to one tenant: the
 * audit row is written to every organisation where the user has an ACTIVE membership (§5.1). No row
 * is written for an unknown e-mail.
 */
export async function auditAccount(user: { id: string; name: string }, action: string, o: { meta?: Record<string, unknown>; request?: SessionMeta; actor?: ServiceContext } = {}) {
  const orgs = await withUser(user.id, (tx) => tx.membership.findMany({ where: { userId: user.id, status: "ACTIVE" }, select: { organizationId: true } }));
  for (const { organizationId } of orgs) {
    const ctx: ServiceContext =
      o.actor && o.actor.orgId === organizationId
        ? o.actor
        : { ...systemContext(organizationId), userId: user.id, userName: user.name, request: o.request ? { ip: o.request.ip ?? null, userAgent: o.request.userAgent ?? null } : undefined };
    await withTenant({ orgId: organizationId, userId: user.id }, (tx) => audit(tx, ctx, { action, entityType: "USER", entityId: user.id, meta: o.meta }));
  }
}
