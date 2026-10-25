import { createId } from "@/lib/id";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { hashPassword, passwordProblems, verifyPassword } from "@/server/auth/password";
import { createSession, type SessionMeta } from "@/server/auth/session-store";
import { sha256Hex } from "@/server/auth/crypto";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { listUserOrganizations } from "@/server/authz/load-context";
import { homePathFor } from "@/server/authz/roles";
import { systemContext } from "@/server/authz/context";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { bootstrapOrganization } from "@/server/modules/org/bootstrap";
import { acceptInviteSchema, loginSchema, registerSchema } from "@/server/modules/org/schemas";
import type { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { recordFailedLogin } from "@/server/auth/lockout";
import { issueMfaChallenge, RECOVERY_LOW_WATERMARK, verifyMfaChallenge, type MfaChallenge } from "./mfa";
import { defaultSecuritySettings, mfaRequirementsForUser } from "./mfa-policy";


export async function registerAgency(input: z.input<typeof registerSchema>, meta: SessionMeta = {}) {
  const data = registerSchema.parse(input);
  await enforceRateLimit(`register:${meta.ip ?? "unknown"}`, 10, 3600);
  const problems = passwordProblems(data.password);
  if (problems.length) throw new ValidationError(problems[0], { password: problems });
  if (await db.user.findUnique({ where: { email: data.email } })) throw new ValidationError("errors.emailTaken", { email: ["errors.emailTaken"] });
  const passwordHash = await hashPassword(data.password);
  const orgId = createId();
  const userId = createId();
  try {
    await withTenant({ orgId, userId }, async (tx) => {
      await tx.user.create({ data: { id: userId, email: data.email, name: data.name, nameAr: data.locale === "ar" ? data.name : null, passwordHash, locale: data.locale } });
      // new organisations require MFA for privileged roles from day one (§5.2), with the 14-day grace
      await tx.organization.create({ data: { id: orgId, slug: data.orgSlug, name: data.orgName, defaultLocale: data.locale, settings: defaultSecuritySettings() as unknown as Prisma.InputJsonValue } });
      const roles = await bootstrapOrganization(tx, orgId, userId);
      await tx.membership.create({ data: { organizationId: orgId, userId, roleId: roles.get("owner")!, status: "ACTIVE" } });
      await tx.resourceProfile.create({ data: { organizationId: orgId, userId, kind: "EMPLOYEE" } });
      await audit(tx, { ...systemContext(orgId, data.orgSlug), userId, userName: data.name, request: meta }, { action: "org.create", entityType: "ORGANIZATION", entityId: orgId, summary: data.orgName });
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ValidationError("errors.slugTaken", { orgSlug: ["errors.slugTaken"] });
    throw err;
  }
  const session = await createSession(userId, meta);
  return { userId, orgId, orgSlug: data.orgSlug, session, redirectTo: `/o/${data.orgSlug}` };
}

export type LoginResult =
  | { mfa: false; userId: string; session: { token: string; expiresAt: Date }; redirectTo: string; locale: string }
  | { mfa: true; challenge: MfaChallenge; locale: string };

/**
 * Password step. With MFA on, no session exists yet: an MFA challenge is returned instead (§5.2) and
 * the failed-login counter is only cleared once the second step succeeds.
 */
export async function login(input: z.input<typeof loginSchema>, meta: SessionMeta = {}): Promise<LoginResult> {
  const data = loginSchema.parse(input);
  await enforceRateLimit(`login:ip:${meta.ip ?? "unknown"}`, 30, 600);
  await enforceRateLimit(`login:email:${data.email}`, 10, 600);
  const user = await db.user.findUnique({ where: { email: data.email } });
  if (!user || !user.passwordHash) {
    // equalize timing with a dummy verify
    await verifyPassword("$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000", data.password);
    throw new AppError("auth.invalidCredentials", "INVALID_CREDENTIALS", 401);
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) throw new AppError("auth.locked", "LOCKED", 423);
  const ok = await verifyPassword(user.passwordHash, data.password);
  if (!ok) {
    await recordFailedLogin(user.id);
    throw new AppError("auth.invalidCredentials", "INVALID_CREDENTIALS", 401);
  }
  if (user.mfaEnabledAt && user.mfaSecretEnc) return { mfa: true, challenge: await issueMfaChallenge(user.id), locale: user.locale };
  await db.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  return { mfa: false, userId: user.id, session: await createSession(user.id, meta), redirectTo: await landingFor(user.id, null), locale: user.locale };
}

/** Second step: a TOTP or a recovery code against the challenge. A session only on success. */
export async function completeMfaLogin(challengeToken: string, input: { code?: string | null; recoveryCode?: string | null }, meta: SessionMeta = {}) {
  const r = await verifyMfaChallenge(challengeToken, input, meta);
  if (!r.ok) return r;
  const user = await db.user.findUniqueOrThrow({ where: { id: r.userId }, select: { locale: true, mfaEnabledAt: true } });
  const session = await createSession(r.userId, meta);
  const redirectTo = r.usedRecoveryCode && r.recoveryLeft <= RECOVERY_LOW_WATERMARK ? "/account?recovery=low" : await landingFor(r.userId, user.mfaEnabledAt);
  return { ok: true as const, session, redirectTo, locale: user.locale };
}

/**
 * Where a signed-in user lands: their workspace, the org picker, or — when an organisation requires
 * MFA for their role and they haven't set it up — the enrolment interstitial (grace: skippable).
 */
async function landingFor(userId: string, mfaEnabledAt: Date | null): Promise<string> {
  const orgs = await listUserOrganizations(userId);
  const home = orgs.length === 1 ? homePathFor(orgs[0].role.baseRole, orgs[0].organization.slug) : "/select-org";
  if (mfaEnabledAt) return home;
  const req = await mfaRequirementsForUser(userId, null);
  if (!req.length) return home;
  return `/mfa-setup?next=${encodeURIComponent(home)}`;
}

/** Resolve an invitation token to its tenant + invitation (public, pre-tenant). */
export async function resolveInvitation(token: string) {
  const pt = await db.publicToken.findUnique({ where: { id: sha256Hex(token) } });
  if (!pt || pt.kind !== "INVITATION" || pt.usedAt || (pt.expiresAt && pt.expiresAt < new Date())) return null;
  return withTenant({ orgId: pt.organizationId }, async (tx) => {
    const inv = await tx.invitation.findUnique({ where: { id: pt.refId } });
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) return null;
    const [org, role] = await Promise.all([
      tx.organization.findUnique({ where: { id: pt.organizationId }, select: { name: true, slug: true, brandColor: true } }),
      tx.role.findUnique({ where: { id: inv.roleId } }),
    ]);
    const existingUser = await tx.user.findUnique({ where: { email: inv.email }, select: { id: true } });
    return { invitation: inv, org: org!, role: role!, orgId: pt.organizationId, existingUser: !!existingUser };
  });
}

export async function acceptInvitation(input: z.input<typeof acceptInviteSchema>, meta: SessionMeta = {}) {
  const data = acceptInviteSchema.parse(input);
  await enforceRateLimit(`invite:${meta.ip ?? "unknown"}`, 20, 600);
  const resolved = await resolveInvitation(data.token);
  if (!resolved) throw new NotFoundError("errors.tokenInvalid");
  const { invitation: inv, orgId, role, org } = resolved;
  const user = await db.user.findUnique({ where: { email: inv.email } });
  if (user) {
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, data.password))) throw new AppError("auth.invalidCredentials", "INVALID_CREDENTIALS", 401);
  } else {
    const problems = passwordProblems(data.password);
    if (problems.length) throw new ValidationError(problems[0], { password: problems });
    if (!data.name) throw new ValidationError("errors.validation", { name: ["common.required"] });
  }
  const passwordHash = user ? null : await hashPassword(data.password);
  const userId = user?.id ?? createId();
  await withTenant({ orgId, userId }, async (tx) => {
    // compare-and-set: only one acceptance wins
    const claimed = await tx.invitation.updateMany({ where: { id: inv.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
    if (claimed.count !== 1) throw new ConflictError("errors.tokenInvalid");
    if (!user) await tx.user.create({ data: { id: userId, email: inv.email, name: data.name!, nameAr: data.name, passwordHash: passwordHash! } });
    const existing = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId } } });
    if (existing) {
      await tx.membership.update({ where: { id: existing.id }, data: { status: "ACTIVE", roleId: inv.roleId, clientId: inv.clientId, vendorId: inv.vendorId, revokedAt: null } });
    } else {
      await tx.membership.create({ data: { organizationId: orgId, userId, roleId: inv.roleId, clientId: inv.clientId, vendorId: inv.vendorId, invitedById: inv.invitedById, status: "ACTIVE" } });
    }
    const kind = role.baseRole === "FIELD_AGENT" ? "DRIVER" : role.baseRole === "FREELANCER" ? "FREELANCER" : "EMPLOYEE";
    if (!["CLIENT", "CLIENT_APPROVER", "VENDOR"].includes(role.baseRole)) {
      await tx.resourceProfile.upsert({
        where: { organizationId_userId: { organizationId: orgId, userId } },
        create: { organizationId: orgId, userId, kind, dailyCapacity: kind === "DRIVER" ? 25 : 8 },
        update: {},
      });
    }
    if (inv.projectId) {
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: inv.projectId, userId } },
        create: { organizationId: orgId, projectId: inv.projectId, userId, role: inv.projectRole ?? "MEMBER", addedById: inv.invitedById },
        update: {},
      });
    }
    await tx.publicToken.update({ where: { id: sha256Hex(data.token) }, data: { usedAt: new Date() } });
    await audit(tx, { ...systemContext(orgId, org.slug), userId, userName: user?.name ?? data.name ?? inv.email, request: meta }, { action: "member.join", entityType: "MEMBERSHIP", entityId: userId, summary: `${inv.email} → ${role.key}` });
  });
  // an existing account with MFA on gets no session here: it signs in through both steps
  if (user?.mfaEnabledAt) return { userId, session: null, redirectTo: `/login?next=${encodeURIComponent(homePathFor(role.baseRole, org.slug))}` };
  const session = await createSession(userId, meta);
  return { userId, session, redirectTo: homePathFor(role.baseRole, org.slug) };
}
