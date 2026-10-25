import type { Prisma } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan } from "@/server/authz/policy";
import { withTenant, withUser, type Tx } from "@/server/db/tenant";
import { ForbiddenError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";

/**
 * Organisation MFA policy (BUSINESS_RULES §5.2), stored in `Organization.settings.security`
 * (Stream N's key; read-merge-write of that key only).
 *
 * Privileged roles: any role holding one of PRIVILEGED_PERMISSIONS (owners and operations directors,
 * plus such custom roles); optionally also `vip.viewSensitive` holders. Grace: 14 days from the later
 * of the policy being switched on and the member joining or changing role. After it, the member's
 * session is enrolment-only for this organisation until MFA is set up.
 */
export const PRIVILEGED_PERMISSIONS = ["org.manage", "org.members.manage", "org.roles.manage", "finance.approve", "campaign.approve", "automation.manage"] as const;
export const VIP_PERMISSION = "vip.viewSensitive";
export const MFA_GRACE_DAYS = 14;
const DAY = 86400_000;

export interface MfaPolicy {
  mfaRequired: boolean;
  /** when the requirement was switched on (ISO); grace counts from here */
  since: string | null;
  /** also require MFA for VIP-data roles (`vip.viewSensitive`), default off (owner decision) */
  includeVip: boolean;
}

export function readMfaPolicy(settings: Prisma.JsonValue | null | undefined): MfaPolicy {
  const sec = ((settings ?? {}) as { security?: Partial<MfaPolicy> }).security ?? {};
  return { mfaRequired: sec.mfaRequired === true, since: typeof sec.since === "string" ? sec.since : null, includeVip: sec.includeVip === true };
}

/** The policy written for a new organisation: MFA required for privileged roles from day one. */
export function defaultSecuritySettings(now = new Date()): { security: MfaPolicy } {
  return { security: { mfaRequired: true, since: now.toISOString(), includeVip: false } };
}

export function isPrivileged(permissions: Iterable<string>, policy: Pick<MfaPolicy, "includeVip">): boolean {
  const set = new Set(permissions);
  if (set.has("*")) return true;
  return PRIVILEGED_PERMISSIONS.some((p) => set.has(p)) || (policy.includeVip && set.has(VIP_PERMISSION));
}

export type MfaGate = { state: "none" } | { state: "grace"; endsAt: Date; daysLeft: number } | { state: "enforced"; endsAt: Date };

/**
 * Whether this member must enrol in MFA for this organisation, and whether the grace period is over.
 * Reads inside the organisation's tenant transaction.
 */
export async function mfaGateTx(tx: Tx, input: { orgId: string; membershipId: string; permissions: Iterable<string>; mfaEnabledAt: Date | null }, now = new Date()): Promise<MfaGate> {
  if (input.mfaEnabledAt) return { state: "none" };
  const org = await tx.organization.findUnique({ where: { id: input.orgId }, select: { settings: true } });
  const policy = readMfaPolicy(org?.settings);
  if (!policy.mfaRequired || !isPrivileged(input.permissions, policy)) return { state: "none" };
  const [membership, roleChange] = await Promise.all([
    tx.membership.findUnique({ where: { id: input.membershipId }, select: { joinedAt: true } }),
    tx.auditEvent.findFirst({ where: { entityType: "MEMBERSHIP", entityId: input.membershipId, action: "member.role_change" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  const starts = [policy.since ? new Date(policy.since) : null, membership?.joinedAt ?? null, roleChange?.createdAt ?? null].filter((d): d is Date => !!d && !Number.isNaN(d.getTime()));
  const start = starts.length ? new Date(Math.max(...starts.map((d) => d.getTime()))) : now;
  const endsAt = new Date(start.getTime() + MFA_GRACE_DAYS * DAY);
  if (now.getTime() >= endsAt.getTime()) return { state: "enforced", endsAt };
  return { state: "grace", endsAt, daysLeft: Math.max(1, Math.ceil((endsAt.getTime() - now.getTime()) / DAY)) };
}

/** The gate for a request context (used by request.ts: enforced → enrolment-only). */
export function mfaGateFor(ctx: Pick<ServiceContext, "orgId" | "userId" | "membershipId" | "permissions">, mfaEnabledAt: Date | null, now = new Date()): Promise<MfaGate> {
  if (mfaEnabledAt) return Promise.resolve({ state: "none" });
  // a role no policy can cover (field agents, clients, most staff) needs no lookup on every request
  if (!isPrivileged(ctx.permissions, { includeVip: true })) return Promise.resolve({ state: "none" });
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => mfaGateTx(tx, { orgId: ctx.orgId, membershipId: ctx.membershipId, permissions: ctx.permissions, mfaEnabledAt }, now));
}

/** Every organisation of the user whose policy covers their role (login prompt, disable refusal). */
export async function mfaRequirementsForUser(userId: string, mfaEnabledAt: Date | null, now = new Date()) {
  const memberships = await withUser(userId, (tx) =>
    tx.membership.findMany({ where: { userId, status: "ACTIVE" }, select: { id: true, organizationId: true, role: { select: { permissions: true } }, organization: { select: { slug: true, name: true, settings: true } } } }),
  );
  const out: { orgId: string; slug: string; name: string; gate: MfaGate }[] = [];
  for (const m of memberships) {
    const policy = readMfaPolicy(m.organization.settings);
    if (!policy.mfaRequired || !isPrivileged(m.role.permissions, policy)) continue;
    // evaluated as if not enrolled: "required for my role" holds whether or not I have set it up
    const gate = await withTenant({ orgId: m.organizationId, userId }, (tx) => mfaGateTx(tx, { orgId: m.organizationId, membershipId: m.id, permissions: m.role.permissions, mfaEnabledAt: null }, now));
    out.push({ orgId: m.organizationId, slug: m.organization.slug, name: m.organization.name, gate: mfaEnabledAt ? { state: "none" } : gate });
  }
  return out;
}

// ── Settings → Security (owners change it; owners and directors see it) ─────────

export async function getSecuritySettings(ctx: ServiceContext, now = new Date()) {
  assertCan(ctx, "org.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { settings: true } });
    const policy = readMfaPolicy(org.settings);
    const [roles, memberships] = await Promise.all([
      tx.role.findMany({ select: { id: true, key: true, nameAr: true, nameEn: true, permissions: true } }),
      tx.membership.findMany({ where: { status: "ACTIVE" }, select: { id: true, userId: true, roleId: true, joinedAt: true, role: { select: { baseRole: true, permissions: true, nameAr: true, nameEn: true } } } }),
    ]);
    const privilegedRoles = roles.filter((r) => isPrivileged(r.permissions, policy)).map((r) => ({ id: r.id, key: r.key, nameAr: r.nameAr, nameEn: r.nameEn }));
    const covered = memberships.filter((m) => isPrivileged(m.role.permissions, policy));
    const users = await tx.user.findMany({ where: { id: { in: covered.map((m) => m.userId) } }, select: { id: true, name: true, nameAr: true, email: true, mfaEnabledAt: true } });
    const members = [];
    for (const m of covered) {
      const u = users.find((x) => x.id === m.userId);
      if (!u) continue;
      const gate = policy.mfaRequired ? await mfaGateTx(tx, { orgId: ctx.orgId, membershipId: m.id, permissions: m.role.permissions, mfaEnabledAt: u.mfaEnabledAt }, now) : ({ state: "none" } as MfaGate);
      members.push({
        membershipId: m.id,
        userId: u.id,
        name: (ctx.locale === "ar" && u.nameAr) || u.name,
        email: u.email,
        role: ctx.locale === "ar" ? m.role.nameAr : m.role.nameEn,
        baseRole: m.role.baseRole,
        enrolled: !!u.mfaEnabledAt,
        enrolledAt: u.mfaEnabledAt,
        gate,
        self: u.id === ctx.userId,
      });
    }
    return {
      policy,
      privilegedRoles,
      members,
      notEnrolled: members.filter((m) => !m.enrolled).length,
      canEdit: ctx.role === "OWNER",
      graceDays: MFA_GRACE_DAYS,
    };
  });
}

/** Owner only, audited `org.mfa_policy`. Switching on starts the grace period now. */
export async function setMfaPolicy(ctx: ServiceContext, input: { mfaRequired: boolean; includeVip?: boolean }, now = new Date()) {
  if (ctx.role !== "OWNER" && !ctx.permissions.has("*")) throw new ForbiddenError();
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    // read-merge-write of our own key, under a row lock so concurrent settings saves don't lose it
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${ctx.orgId} FOR UPDATE`;
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { settings: true } });
    const before = readMfaPolicy(org.settings);
    const since = input.mfaRequired ? (before.mfaRequired && before.since ? before.since : now.toISOString()) : null;
    const next: MfaPolicy = { mfaRequired: input.mfaRequired, since, includeVip: input.includeVip ?? before.includeVip };
    const settings = { ...((org.settings ?? {}) as Record<string, unknown>), security: next };
    await tx.organization.update({ where: { id: ctx.orgId }, data: { settings: settings as unknown as Prisma.InputJsonValue } });
    await audit(tx, ctx, { action: "org.mfa_policy", entityType: "ORGANIZATION", entityId: ctx.orgId, before, after: next, summary: `${before.mfaRequired ? "on" : "off"} → ${next.mfaRequired ? "on" : "off"}` });
    return next;
  });
}
