import { z } from "zod";
import { createId } from "@/lib/id";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan } from "@/server/authz/policy";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { AppError, NotFoundError, ValidationError } from "@/server/errors";
import { randomToken, sha256Hex } from "@/server/auth/crypto";
import { hashPassword, passwordProblems } from "@/server/auth/password";
import { rateLimit } from "@/server/auth/rate-limit";
import type { SessionMeta } from "@/server/auth/session-store";
import { audit } from "@/server/modules/audit/audit";
import { afterResponse, createSystemEmail, deliverSystemEmail } from "@/server/modules/email/system";
import { appUrl } from "@/server/modules/email/templates";
import { auditAccount } from "./account-security";

/**
 * Password recovery (BUSINESS_RULES §5.1).
 *  - Request: always the same response, whether or not the account exists, is locked or over the
 *    limit; the work happens after the response (no timing difference to observe).
 *  - Token: 32 random bytes; only its SHA-256 is stored (PublicToken PASSWORD_RESET, organizationId "");
 *    30 minutes; single use; a new request invalidates earlier unused tokens.
 *  - Limits: 3 per e-mail and 10 per IP per hour; over the limit nothing is sent.
 *  - The link is rendered into one e-mail and never persisted (SystemEmail keeps no secret).
 *  - Completion: new Argon2id hash, `passwordChangedAt`, token consumed, every session revoked, earlier
 *    reset and MFA-challenge tokens voided, lockout cleared, "password changed" e-mail. No sign-in.
 */
export const RESET_TOKEN_TTL_MS = 30 * 60_000;
export const RESET_LIMIT_PER_EMAIL = 3;
export const RESET_LIMIT_PER_IP = 10;

/** What the forgot-password endpoint answers, always. */
export const FORGOT_RESPONSE = Object.freeze({ ok: true as const, data: null });

export const forgotSchema = z.object({ email: z.string().trim().toLowerCase().max(200) });
export const resetSchema = z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(200) });

/**
 * The forgot-password request. Returns FORGOT_RESPONSE at once; the lookup, token and e-mail run after
 * the response inside a request (`after()`), or before returning elsewhere (tests, scripts).
 */
export async function submitForgotPassword(input: unknown, meta: SessionMeta = {}, now = new Date()): Promise<typeof FORGOT_RESPONSE> {
  const parsed = forgotSchema.safeParse(input);
  if (parsed.success) await afterResponse(() => requestPasswordReset(parsed.data.email, meta, now));
  return FORGOT_RESPONSE;
}

/** Issues a reset link when allowed. Silent in every case (the caller's response never changes). */
export async function requestPasswordReset(email: string, meta: SessionMeta = {}, now = new Date(), o: { byAdmin?: ServiceContext } = {}): Promise<"sent" | "skipped"> {
  if (!z.string().email().safeParse(email).success) return "skipped";
  const ip = await rateLimit(`pwreset:ip:${meta.ip ?? "unknown"}`, RESET_LIMIT_PER_IP, 3600);
  const perEmail = await rateLimit(`pwreset:email:${email}`, RESET_LIMIT_PER_EMAIL, 3600);
  if (!ip.ok || !perEmail.ok) return "skipped";
  const user = await db.user.findUnique({ where: { email }, select: { id: true, email: true, name: true, locale: true } });
  if (!user) return "skipped";
  const token = randomToken(32);
  const emailId = await db.$transaction(async (tx) => {
    // a new link voids every earlier unused one
    await tx.publicToken.updateMany({ where: { kind: "PASSWORD_RESET", refId: user.id, usedAt: null }, data: { usedAt: now } });
    await tx.publicToken.create({ data: { id: sha256Hex(token), kind: "PASSWORD_RESET", organizationId: "", refId: user.id, expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS) } });
    return null;
  }).then(() =>
    createSystemEmail({ userId: user.id, to: user.email, template: "password_reset", locale: user.locale, params: { at: now.toISOString(), ip: meta.ip ?? null }, dedupeKey: `password_reset:${user.id}:${createId()}` }),
  );
  await auditAccount(user, "auth.password_reset_requested", { request: meta, meta: { byAdmin: o.byAdmin ? o.byAdmin.userId : undefined }, actor: o.byAdmin });
  if (emailId) await deliverSystemEmail(emailId, { link: `${appUrl()}/reset/${token}` }, now);
  return "sent";
}

/** Read-only check for the reset page: is this link usable right now? (No detail on why not.) */
export async function resetTokenValid(token: string, now = new Date()): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const pt = await db.publicToken.findUnique({ where: { id: sha256Hex(token) } });
  return !!pt && pt.kind === "PASSWORD_RESET" && !pt.usedAt && !!pt.expiresAt && pt.expiresAt > now;
}

/** Sets the new password. Throws `auth.reset.invalid` (neutral) for any unusable link. */
export async function completePasswordReset(input: z.input<typeof resetSchema>, meta: SessionMeta = {}, now = new Date()) {
  const data = resetSchema.parse(input);
  await enforceIpLimit(meta);
  if (!(await resetTokenValid(data.token, now))) throw new AppError("auth.reset.invalid", "TOKEN_INVALID", 400);
  const problems = passwordProblems(data.password);
  if (problems.length) throw new ValidationError(problems[0], { password: problems });
  const passwordHash = await hashPassword(data.password);
  const id = sha256Hex(data.token);
  const user = await db.$transaction(async (tx) => {
    // compare-and-set: one use only, even under a double submit
    const claimed = await tx.publicToken.updateMany({ where: { id, kind: "PASSWORD_RESET", usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (claimed.count !== 1) throw new AppError("auth.reset.invalid", "TOKEN_INVALID", 400);
    const pt = await tx.publicToken.findUniqueOrThrow({ where: { id } });
    const u = await tx.user.update({ where: { id: pt.refId }, data: { passwordHash, passwordChangedAt: now, failedLogins: 0, lockedUntil: null }, select: { id: true, email: true, name: true, locale: true } });
    await tx.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: now } });
    // earlier reset links and pending MFA challenges die with the old password
    await tx.publicToken.updateMany({ where: { kind: { in: ["PASSWORD_RESET", "MFA_CHALLENGE"] }, usedAt: null, OR: [{ refId: u.id }, { refId: { startsWith: `${u.id}:` } }] }, data: { usedAt: now } });
    return u;
  });
  const mailId = await createSystemEmail({ userId: user.id, to: user.email, template: "password_changed", locale: user.locale, params: { at: now.toISOString(), ip: meta.ip ?? null }, dedupeKey: `password_changed:${user.id}:${now.getTime()}` });
  await auditAccount(user, "auth.password_reset_completed", { request: meta });
  if (mailId) await afterResponse(() => deliverSystemEmail(mailId));
  return { redirectTo: "/login?reset=1" };
}

async function enforceIpLimit(meta: SessionMeta) {
  const r = await rateLimit(`pwreset:complete:${meta.ip ?? "unknown"}`, 20, 3600);
  if (!r.ok) throw new AppError("errors.rateLimited", "RATE_LIMITED", 429);
}

/**
 * Admin action "Send reset link" (§5.1): same flow and limits; audited `member.reset_link_sent`; the
 * admin never sees the link.
 */
export async function sendResetLinkByAdmin(ctx: ServiceContext, input: { membershipId: string }) {
  assertCan(ctx, "org.members.manage");
  const target = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const m = await tx.membership.findFirst({ where: { id: input.membershipId, organizationId: ctx.orgId, status: "ACTIVE" }, include: { role: { select: { baseRole: true } } } });
    if (!m) throw new NotFoundError();
    // only an owner acts on an owner (M1 rule)
    if (m.role.baseRole === "OWNER" && ctx.role !== "OWNER") throw new NotFoundError();
    const u = await tx.user.findUniqueOrThrow({ where: { id: m.userId }, select: { id: true, email: true, name: true } });
    await audit(tx, ctx, { action: "member.reset_link_sent", entityType: "MEMBERSHIP", entityId: m.id, summary: u.name });
    return u;
  });
  await afterResponse(() => requestPasswordReset(target.email, ctx.request ?? {}, new Date(), { byAdmin: ctx }));
  return null;
}
