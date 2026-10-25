import QRCode from "qrcode";
import { randomInt } from "node:crypto";
import { z } from "zod";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan } from "@/server/authz/policy";
import { db } from "@/server/db/client";
import { withTenant, withUser } from "@/server/db/tenant";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "@/server/auth/crypto";
import { recordFailedLogin } from "@/server/auth/lockout";
import { verifyPassword } from "@/server/auth/password";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import type { SessionMeta } from "@/server/auth/session-store";
import { generateTotpSecret, otpauthUri, verifyTotp } from "@/server/auth/totp";
import { audit } from "@/server/modules/audit/audit";
import { afterResponse, createSystemEmail, deliverSystemEmail } from "@/server/modules/email/system";
import type { SystemTemplate } from "@/server/modules/email/templates";
import { notify } from "@/server/modules/notifications/notify";
import { auditAccount } from "./account-security";
import { mfaRequirementsForUser } from "./mfa-policy";

/**
 * Two-step verification (BUSINESS_RULES §5.2): TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step) with
 * replay protection (`mfaLastStep`, compare-and-set) and 10 one-time recovery codes stored as SHA-256.
 * The TOTP secret is encrypted at rest (AES-256-GCM, key from APP_SECRET via HKDF).
 *
 * Login: a correct password with MFA on creates NO session; it issues an MFA_CHALLENGE token
 * (5 minutes, single use). Every attempt consumes the challenge; a wrong code issues a successor that
 * carries the failure count (`refId = userId:n`), so 5 wrong codes end the challenge. Each wrong code
 * also counts toward the account lockout.
 */
export const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
export const MFA_MAX_WRONG_CODES = 5;
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_LOW_WATERMARK = 2;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const reasonSchema = z.string().trim().min(10).max(1000);

// ── Recovery codes ───────────────────────────────────────────────────────────

export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const one = () => Array.from({ length: 8 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("");
  const codes = new Set<string>();
  while (codes.size < n) codes.add(one());
  return [...codes].map((c) => `${c.slice(0, 4)}-${c.slice(4)}`);
}

export function hashRecoveryCode(code: string): string {
  return sha256Hex(code.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

// ── Status ───────────────────────────────────────────────────────────────────

export async function getMfaStatus(userId: string, now = new Date()) {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaEnabledAt: true, mfaRecoveryCodes: true } });
  const required = await mfaRequirementsForUser(userId, u.mfaEnabledAt, now);
  return {
    enabled: !!u.mfaEnabledAt,
    enabledAt: u.mfaEnabledAt,
    recoveryLeft: u.mfaEnabledAt ? u.mfaRecoveryCodes.length : 0,
    lowOnCodes: !!u.mfaEnabledAt && u.mfaRecoveryCodes.length <= RECOVERY_LOW_WATERMARK,
    requiredBy: required.map((r) => ({ name: r.name, slug: r.slug, gate: r.gate })),
    canDisable: !required.length,
  };
}

async function securityMail(user: { id: string; email: string; locale: string }, template: SystemTemplate, params: Record<string, string | number | null>, now: Date) {
  const id = await createSystemEmail({ userId: user.id, to: user.email, template, locale: user.locale, params: { at: now.toISOString(), ...params }, dedupeKey: `${template}:${user.id}:${now.getTime()}:${randomToken(6)}` });
  if (id) await afterResponse(() => deliverSystemEmail(id));
}

async function checkPassword(userId: string, password: string) {
  await enforceRateLimit(`mfa:password:${userId}`, 10, 900);
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
  if (!u.passwordHash || !(await verifyPassword(u.passwordHash, password))) throw new ValidationError("errors.validation", { password: ["auth.invalidCredentials"] });
}

/** Verifies a current TOTP and records its step (compare-and-set), so the same code never works twice. */
async function consumeTotp(userId: string, code: string, now: Date): Promise<boolean> {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaSecretEnc: true, mfaLastStep: true } });
  if (!u.mfaSecretEnc) return false;
  const step = verifyTotp(decryptSecret(u.mfaSecretEnc), code, now, u.mfaLastStep);
  if (step === null) return false;
  const r = await db.user.updateMany({ where: { id: userId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] }, data: { mfaLastStep: step } });
  return r.count === 1;
}

async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const hash = hashRecoveryCode(code);
  const n = await db.$executeRaw`UPDATE "User" SET "mfaRecoveryCodes" = array_remove("mfaRecoveryCodes", ${hash}) WHERE id = ${userId} AND "mfaEnabledAt" IS NOT NULL AND ${hash} = ANY("mfaRecoveryCodes")`;
  return n === 1;
}

// ── Enrolment (/account and the forced-enrolment interstitial) ───────────────

/** Step 1: re-enter the password; returns the secret (manual key), its otpauth URI and a QR image. */
export async function beginMfaEnrolment(userId: string, password: string) {
  await checkPassword(userId, password);
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, mfaEnabledAt: true } });
  if (u.mfaEnabledAt) throw new ValidationError("auth.mfa.alreadyEnabled");
  const secret = generateTotpSecret();
  // pending until confirmed: login ignores a secret without mfaEnabledAt
  await db.user.update({ where: { id: userId }, data: { mfaSecretEnc: encryptSecret(secret), mfaLastStep: null } });
  const uri = otpauthUri(secret, u.email);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 384, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
  return { secret, uri, qr };
}

/** Step 2: one valid code switches MFA on and returns 10 recovery codes (shown once). */
export async function confirmMfaEnrolment(userId: string, code: string, meta: SessionMeta = {}, now = new Date()) {
  await enforceRateLimit(`mfa:confirm:${userId}`, 10, 900);
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, email: true, locale: true, mfaSecretEnc: true, mfaEnabledAt: true } });
  if (u.mfaEnabledAt) throw new ValidationError("auth.mfa.alreadyEnabled");
  if (!u.mfaSecretEnc) throw new ValidationError("auth.mfa.restart");
  const step = verifyTotp(decryptSecret(u.mfaSecretEnc), code, now, null);
  if (step === null) throw new ValidationError("errors.validation", { code: ["auth.mfa.codeMismatch"] });
  const codes = generateRecoveryCodes();
  const r = await db.user.updateMany({ where: { id: userId, mfaEnabledAt: null }, data: { mfaEnabledAt: now, mfaLastStep: step, mfaRecoveryCodes: codes.map(hashRecoveryCode) } });
  if (r.count !== 1) throw new ValidationError("auth.mfa.alreadyEnabled");
  await securityMail(u, "mfa_enabled", { ip: meta.ip ?? null }, now);
  await auditAccount(u, "auth.mfa_enabled", { request: meta });
  return { recoveryCodes: codes };
}

/** New recovery codes (the old ones stop working). Needs the password and a current code. */
export async function regenerateRecoveryCodes(userId: string, input: { password: string; code: string }, meta: SessionMeta = {}, now = new Date()) {
  await checkPassword(userId, input.password);
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, mfaEnabledAt: true } });
  if (!u.mfaEnabledAt) throw new ValidationError("auth.mfa.notEnabled");
  if (!(await consumeTotp(userId, input.code, now))) throw new ValidationError("errors.validation", { code: ["auth.mfa.codeMismatch"] });
  const codes = generateRecoveryCodes();
  await db.user.update({ where: { id: userId }, data: { mfaRecoveryCodes: codes.map(hashRecoveryCode) } });
  await auditAccount(u, "auth.mfa_recovery_regenerated", { request: meta });
  return { recoveryCodes: codes };
}

/** Turn off own MFA: password + current code; refused while any organisation requires it for the role. */
export async function disableMfa(userId: string, input: { password: string; code: string }, meta: SessionMeta = {}, now = new Date()) {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, email: true, locale: true, mfaEnabledAt: true } });
  if (!u.mfaEnabledAt) throw new ValidationError("auth.mfa.notEnabled");
  if ((await mfaRequirementsForUser(userId, null, now)).length) throw new ForbiddenError("auth.mfa.requiredByOrg");
  await checkPassword(userId, input.password);
  if (!(await consumeTotp(userId, input.code, now))) throw new ValidationError("errors.validation", { code: ["auth.mfa.codeMismatch"] });
  await clearMfa(userId);
  await securityMail(u, "mfa_disabled", { ip: meta.ip ?? null }, now);
  await auditAccount(u, "auth.mfa_disabled", { request: meta });
  return null;
}

async function clearMfa(userId: string) {
  await db.user.update({ where: { id: userId }, data: { mfaSecretEnc: null, mfaEnabledAt: null, mfaRecoveryCodes: [], mfaLastStep: null } });
}

/**
 * Admin reset for a lost device (§5.2): an owner, or a director for non-owner members; never oneself;
 * a reason is required. Refused when the person also belongs to another organisation (MFA is per
 * account: "contact Opera support"). Clears MFA, revokes every session, e-mails the user, tells the
 * other owners, audits `auth.mfa_reset_by_admin`.
 */
export async function adminResetMfa(ctx: ServiceContext, input: { membershipId: string; reason: string }, now = new Date()) {
  assertCan(ctx, "org.members.manage");
  const reason = reasonSchema.safeParse(input.reason);
  if (!reason.success) throw new ValidationError("errors.validation", { reason: ["errors.reasonRequired"] });
  if (ctx.role !== "OWNER" && ctx.role !== "OPS_DIRECTOR") throw new ForbiddenError();
  const target = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const m = await tx.membership.findFirst({ where: { id: input.membershipId, organizationId: ctx.orgId, status: { not: "REVOKED" } }, include: { role: { select: { baseRole: true } } } });
    if (!m) throw new NotFoundError();
    return m;
  });
  if (target.userId === ctx.userId) throw new ForbiddenError("auth.mfa.resetSelf");
  if (target.role.baseRole === "OWNER" && ctx.role !== "OWNER") throw new ForbiddenError();
  const elsewhere = await withUser(target.userId, (tx) => tx.membership.count({ where: { userId: target.userId, status: "ACTIVE", organizationId: { not: ctx.orgId } } }));
  if (elsewhere) throw new ValidationError("auth.mfa.resetMultiOrg");
  const user = await db.user.findUniqueOrThrow({ where: { id: target.userId }, select: { id: true, name: true, email: true, locale: true, mfaEnabledAt: true } });
  if (!user.mfaEnabledAt) throw new ValidationError("auth.mfa.notEnabled");
  await clearMfa(user.id);
  await db.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
  await db.publicToken.updateMany({ where: { kind: "MFA_CHALLENGE", usedAt: null, refId: { startsWith: `${user.id}:` } }, data: { usedAt: now } });
  await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    await audit(tx, ctx, { action: "auth.mfa_reset_by_admin", entityType: "MEMBERSHIP", entityId: target.id, summary: user.name, meta: { userId: user.id, reason: reason.data } });
    const owners = await tx.membership.findMany({ where: { status: "ACTIVE", role: { baseRole: "OWNER" }, userId: { notIn: [ctx.userId, user.id] } }, select: { userId: true } });
    await notify(tx, { orgId: ctx.orgId, userIds: owners.map((o) => o.userId), type: "security.mfa_reset", titleKey: "notif.mfaResetByAdmin", params: { name: user.name }, link: "/settings/security", entityType: "MEMBERSHIP", entityId: target.id, mandatory: true });
  });
  const org = await withTenant({ orgId: ctx.orgId }, (tx) => tx.organization.findUnique({ where: { id: ctx.orgId }, select: { name: true } }));
  await securityMail(user, "mfa_reset", { org: org?.name ?? "" }, now);
  return null;
}

// ── Login: the second step ───────────────────────────────────────────────────

export interface MfaChallenge {
  token: string;
  expiresAt: Date;
}

export async function issueMfaChallenge(userId: string, now = new Date(), failures = 0, expiresAt?: Date): Promise<MfaChallenge> {
  const token = randomToken(32);
  const exp = expiresAt ?? new Date(now.getTime() + MFA_CHALLENGE_TTL_MS);
  await db.publicToken.create({ data: { id: sha256Hex(token), kind: "MFA_CHALLENGE", organizationId: "", refId: `${userId}:${failures}`, expiresAt: exp } });
  return { token, expiresAt: exp };
}

export type ChallengeResult =
  | { ok: true; userId: string; usedRecoveryCode: boolean; recoveryLeft: number }
  | { ok: false; error: string; challenge?: MfaChallenge; restart: boolean };

/**
 * Checks a TOTP or recovery code against a challenge. The challenge is consumed by every attempt;
 * a wrong code returns a successor challenge until the 5th wrong code.
 */
export async function verifyMfaChallenge(token: string, input: { code?: string | null; recoveryCode?: string | null }, meta: SessionMeta = {}, now = new Date()): Promise<ChallengeResult> {
  await enforceRateLimit(`mfa:ip:${meta.ip ?? "unknown"}`, 30, 600);
  const expired: ChallengeResult = { ok: false, error: "auth.mfa.challengeExpired", restart: true };
  if (!token || token.length > 200) return expired;
  const id = sha256Hex(token);
  const pt = await db.publicToken.findUnique({ where: { id } });
  if (!pt || pt.kind !== "MFA_CHALLENGE" || pt.usedAt || !pt.expiresAt || pt.expiresAt <= now) return expired;
  const claimed = await db.publicToken.updateMany({ where: { id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  if (claimed.count !== 1) return expired;
  const [userId, n] = pt.refId.split(":");
  const failures = Number(n ?? 0) || 0;
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, locale: true, mfaEnabledAt: true, lockedUntil: true } });
  if (!user?.mfaEnabledAt) return expired;
  if (user.lockedUntil && user.lockedUntil > now) return { ok: false, error: "auth.locked", restart: true };
  const recovery = !!input.recoveryCode?.trim();
  const ok = recovery ? await consumeRecoveryCode(user.id, input.recoveryCode!) : await consumeTotp(user.id, input.code ?? "", now);
  if (ok) {
    const after = await db.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now }, select: { mfaRecoveryCodes: true } });
    if (recovery) {
      await securityMail(user, "recovery_code_used", { remaining: after.mfaRecoveryCodes.length, ip: meta.ip ?? null }, now);
      await auditAccount(user, "auth.recovery_code_used", { request: meta, meta: { remaining: after.mfaRecoveryCodes.length } });
    }
    return { ok: true, userId: user.id, usedRecoveryCode: recovery, recoveryLeft: after.mfaRecoveryCodes.length };
  }
  const locked = await recordFailedLogin(user.id, now);
  if (locked) return { ok: false, error: "auth.locked", restart: true };
  if (failures + 1 >= MFA_MAX_WRONG_CODES) return { ok: false, error: "auth.mfa.tooManyAttempts", restart: true };
  const next = await issueMfaChallenge(user.id, now, failures + 1, pt.expiresAt);
  return { ok: false, error: recovery ? "auth.mfa.recoveryMismatch" : "auth.mfa.codeMismatch", challenge: next, restart: false };
}

