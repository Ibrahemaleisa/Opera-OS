/**
 * Milestone 2, Stream N — account security (BUSINESS_RULES.md §5, PW-1…5, MFA-1…6).
 * Password recovery (no enumeration, single-use 30-minute tokens, limits, sessions revoked) and TOTP
 * MFA (encrypted secret, replay protection, challenge limits, recovery codes, org policy and grace).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { adminDb } from "@/server/db/admin";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { createSession, validateSessionToken } from "@/server/auth/session-store";
import { decryptSecret, encryptSecret } from "@/server/auth/crypto";
import { base32Decode, base32Encode, hotp, totpCode, totpStep, verifyTotp } from "@/server/auth/totp";
import { setMailTransportForTests, type MailTransport } from "@/server/modules/email/transport";
import { completeMfaLogin, login } from "@/server/modules/auth/service";
import { completePasswordReset, FORGOT_RESPONSE, requestPasswordReset, resetTokenValid, sendResetLinkByAdmin, submitForgotPassword } from "@/server/modules/auth/password-reset";
import { adminResetMfa, beginMfaEnrolment, confirmMfaEnrolment, disableMfa, getMfaStatus, regenerateRecoveryCodes } from "@/server/modules/auth/mfa";
import { getSecuritySettings, mfaGateFor, readMfaPolicy, setMfaPolicy } from "@/server/modules/auth/mfa-policy";
import { addMember, createAgency as registerAgencyForTest, ctxFor } from "../helpers";

/** Registration has its own per-IP limit; relax only that (the reset limits under test stay real). */
async function createAgency(name: string) {
  const prev = process.env.RATE_LIMIT_MULTIPLIER;
  process.env.RATE_LIMIT_MULTIPLIER = "1000";
  try {
    return await registerAgencyForTest(name);
  } finally {
    process.env.RATE_LIMIT_MULTIPLIER = prev ?? "1";
  }
}

const MIN = 60_000;
const DAY = 86400_000;
let ipSeq = 0;
const meta = () => ({ ip: `10.9.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}`, userAgent: "vitest" });

/** Captures outgoing mail so a test can read the one-time link (it is never stored). */
function captureMail() {
  const sent: { to: string; subject: string; text: string; html: string }[] = [];
  const t: MailTransport = { sendMail: async (m) => (sent.push(m), { messageId: `<${sent.length}@test>` }) };
  setMailTransportForTests(t);
  return sent;
}
const linkIn = (text: string) => text.match(/\/reset\/([A-Za-z0-9_-]{20,})/)?.[1] ?? null;
/** The newest reset link among captured mail. */
const lastLink = (sent: { text: string }[]) => linkIn([...sent].reverse().find((m) => linkIn(m.text))?.text ?? "")!;
const systemMail = (to: string) => db.systemEmail.findMany({ where: { to }, orderBy: { createdAt: "asc" } });

afterEach(() => setMailTransportForTests(null));

describe("PW — password recovery", () => {
  it("PW-1 known and unknown e-mail get byte-identical responses; only the known one creates a SystemEmail, without the link", async () => {
    const a = await createAgency("PW1");
    const sent = captureMail();
    const unknown = `nobody-${Date.now()}@example.test`;
    const r1 = await submitForgotPassword({ email: unknown }, meta());
    const r2 = await submitForgotPassword({ email: a.email.toUpperCase() }, meta());
    const r3 = await submitForgotPassword({ email: "not-an-email" }, meta());
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r3));
    expect(r1).toEqual(FORGOT_RESPONSE);
    expect(await systemMail(unknown)).toHaveLength(0);
    const mails = await systemMail(a.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ template: "password_reset", status: "SENT" });
    // the link went out once and is stored nowhere
    const token = linkIn(sent[0].text)!;
    expect(token).toBeTruthy();
    expect(JSON.stringify(mails[0])).not.toContain(token);
    const pt = await db.publicToken.findUniqueOrThrow({ where: { id: createHash("sha256").update(token).digest("hex") } });
    expect(pt).toMatchObject({ kind: "PASSWORD_RESET", organizationId: "", refId: a.userId });
    expect(pt.expiresAt!.getTime() - pt.createdAt.getTime()).toBeLessThanOrEqual(30 * MIN + 1000);
    expect(sent[0].subject).toBe("Opera — رابط استعادة كلمة المرور / Password reset link");
    // audited in the user's organisation; nothing for the unknown address
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "auth.password_reset_requested", entityId: a.userId } })).toBe(1);
  });

  it("PW-2 a used token is refused; a 31-minute-old token is refused; a newer request voids the older link", async () => {
    const a = await createAgency("PW2");
    const sent = captureMail();
    await requestPasswordReset(a.email, meta());
    const t1 = linkIn(sent[0].text)!;
    await completePasswordReset({ token: t1, password: "Brand-New-Pass-2026" }, meta());
    await expect(completePasswordReset({ token: t1, password: "Another-Pass-2026" }, meta())).rejects.toThrow("auth.reset.invalid");
    expect(await resetTokenValid(t1)).toBe(false);

    await requestPasswordReset(a.email, meta());
    const t2 = lastLink(sent);
    await expect(completePasswordReset({ token: t2, password: "Brand-New-Pass-2027" }, meta(), new Date(Date.now() + 31 * MIN))).rejects.toThrow("auth.reset.invalid");

    await requestPasswordReset(a.email, meta());
    const t3 = lastLink(sent);
    expect(await resetTokenValid(t2), "a new link invalidates the earlier one").toBe(false);
    expect(await resetTokenValid(t3)).toBe(true);
    // a weak password never consumes the link
    await expect(completePasswordReset({ token: t3, password: "short" }, meta())).rejects.toThrow();
    expect(await resetTokenValid(t3)).toBe(true);
    await expect(completePasswordReset({ token: "x".repeat(43), password: "Brand-New-Pass-2028" }, meta())).rejects.toThrow("auth.reset.invalid");
  });

  it("PW-3 completing a reset revokes all 3 sessions, clears the lockout and sends 'your password was changed'", async () => {
    const a = await createAgency("PW3");
    const sent = captureMail();
    const sessions = await Promise.all([createSession(a.userId), createSession(a.userId), createSession(a.userId)]);
    await db.user.update({ where: { id: a.userId }, data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 10 * MIN) } });
    await requestPasswordReset(a.email, meta());
    const r = await completePasswordReset({ token: linkIn(sent[0].text)!, password: "Brand-New-Pass-2026" }, meta());
    expect(r.redirectTo).toBe("/login?reset=1");
    for (const s of sessions) expect(await validateSessionToken(s.token)).toBeNull();
    expect(await db.session.count({ where: { userId: a.userId, revokedAt: null } })).toBe(0);
    const u = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect(u).toMatchObject({ failedLogins: 0, lockedUntil: null });
    expect(u.passwordChangedAt).not.toBeNull();
    expect((await systemMail(a.email)).map((m) => m.template)).toEqual(["password_reset", "password_changed"]);
    expect(sent.at(-1)!.text).not.toMatch(/\/reset\//); // no link that undoes it
    await expect(login({ email: a.email, password: "Sup3r-Secret-Pass" }, meta())).rejects.toThrow("auth.invalidCredentials");
    const ok = await login({ email: a.email, password: "Brand-New-Pass-2026" }, meta());
    expect(ok.mfa).toBe(false);
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "auth.password_reset_completed" } })).toBe(1);
  });

  it("PW-4 a 4th request within the hour for the same e-mail: same response, no e-mail", async () => {
    const a = await createAgency("PW4");
    captureMail();
    for (let i = 0; i < 4; i++) expect(await submitForgotPassword({ email: a.email }, meta())).toEqual(FORGOT_RESPONSE);
    expect((await systemMail(a.email)).filter((m) => m.template === "password_reset")).toHaveLength(3);
  });

  it("PW-5 with MFA enrolled, signing in after a reset still requires the code", async () => {
    const a = await createAgency("PW5");
    const sent = captureMail();
    const secret = await enrol(a.userId, "Sup3r-Secret-Pass");
    await requestPasswordReset(a.email, meta());
    await completePasswordReset({ token: linkIn(sent.find((m) => m.subject.includes("Password reset"))!.text)!, password: "Brand-New-Pass-2026" }, meta());
    const r = await login({ email: a.email, password: "Brand-New-Pass-2026" }, meta());
    expect(r.mfa).toBe(true);
    expect(await db.session.count({ where: { userId: a.userId, revokedAt: null } })).toBe(0);
    expect(secret).toBeTruthy();
  });

  it("an admin can send a reset link without ever seeing it (audited member.reset_link_sent)", async () => {
    const a = await createAgency("PWAdmin");
    const emp = await addMember(a.ctx, "employee", "Employee");
    const sent = captureMail();
    const membership = await adminDb().membership.findFirstOrThrow({ where: { organizationId: a.orgId, userId: emp.userId } });
    expect(await sendResetLinkByAdmin(a.ctx, { membershipId: membership.id })).toBeNull();
    expect(sent.filter((m) => m.to === emp.email)).toHaveLength(1);
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "member.reset_link_sent", entityId: membership.id } })).toBe(1);
    await expect(sendResetLinkByAdmin(emp.ctx, { membershipId: membership.id })).rejects.toThrow();
  });
});

/** Enrols MFA for a user; returns the base32 secret. */
async function enrol(userId: string, password: string, now = new Date()) {
  const r = await beginMfaEnrolment(userId, password);
  await confirmMfaEnrolment(userId, totpCode(r.secret, now), {}, now);
  return r.secret;
}

describe("MFA — TOTP primitives", () => {
  it("RFC 6238 SHA-1 test vectors; base32 round trip", () => {
    const key = Buffer.from("12345678901234567890");
    const vectors: [number, string][] = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
    for (const [t, code] of vectors) expect(hotp(key, Math.floor(t / 30), 8)).toBe(code);
    const b32 = base32Encode(key);
    expect(b32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(totpCode(b32, 59_000)).toBe("287082");
    expect(base32Decode(b32).equals(key)).toBe(true);
  });

  it("±1 step is accepted, ±2 is not; a step at or below the last accepted one is a replay", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const t = Date.UTC(2026, 9, 25, 12, 0, 15);
    const s = totpStep(t);
    expect(verifyTotp(secret, totpCode(secret, t - 30_000), t)).toBe(s - 1);
    expect(verifyTotp(secret, totpCode(secret, t + 30_000), t)).toBe(s + 1);
    expect(verifyTotp(secret, totpCode(secret, t - 60_000), t)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, t), t, s)).toBeNull();
    expect(verifyTotp(secret, "12345", t)).toBeNull();
  });

  it("the secret is encrypted at rest (AES-256-GCM); tampering is detected", () => {
    const enc = encryptSecret("JBSWY3DPEHPK3PXP");
    expect(enc).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(enc)).toBe("JBSWY3DPEHPK3PXP");
    expect(encryptSecret("JBSWY3DPEHPK3PXP")).not.toBe(enc); // random IV
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});

describe("MFA — enrolment, login, recovery, policy", () => {
  it("enrolment stores an encrypted secret, 10 hashed recovery codes and sends 'MFA enabled'", async () => {
    const a = await createAgency("MFAEnrol");
    captureMail();
    await expect(beginMfaEnrolment(a.userId, "wrong-password")).rejects.toThrow();
    const r = await beginMfaEnrolment(a.userId, "Sup3r-Secret-Pass");
    expect(r.qr.startsWith("data:image/png;base64,")).toBe(true);
    expect(r.uri).toContain("otpauth://totp/Opera");
    await expect(confirmMfaEnrolment(a.userId, "000000")).rejects.toThrow();
    const { recoveryCodes } = await confirmMfaEnrolment(a.userId, totpCode(r.secret));
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    const u = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect(u.mfaEnabledAt).not.toBeNull();
    expect(u.mfaSecretEnc).not.toContain(r.secret);
    expect(decryptSecret(u.mfaSecretEnc!)).toBe(r.secret);
    expect(u.mfaRecoveryCodes).toHaveLength(10);
    expect(u.mfaRecoveryCodes.some((h) => recoveryCodes.some((c) => h.includes(c.replace("-", ""))))).toBe(false);
    expect((await systemMail(a.email)).map((m) => m.template)).toContain("mfa_enabled");
    const st = await getMfaStatus(a.userId);
    expect(st).toMatchObject({ enabled: true, recoveryLeft: 10 });
  });

  it("MFA-1 no session until a valid code; the same code used twice is refused the second time", async () => {
    const a = await createAgency("MFA1");
    captureMail();
    const secret = await enrol(a.userId, "Sup3r-Secret-Pass", new Date(Date.now() - 30_000));
    const before = await db.session.count({ where: { userId: a.userId } }); // registration's own session
    const first = await login({ email: a.email, password: "Sup3r-Secret-Pass" }, meta());
    expect(first.mfa).toBe(true);
    expect(await db.session.count({ where: { userId: a.userId } }), "the password alone creates no session").toBe(before);
    if (!first.mfa) throw new Error("expected a challenge");
    const code = totpCode(secret);
    const ok = await completeMfaLogin(first.challenge.token, { code }, meta());
    expect(ok.ok).toBe(true);
    expect(await db.session.count({ where: { userId: a.userId } })).toBe(before + 1);
    // the challenge itself is single use
    expect((await completeMfaLogin(first.challenge.token, { code }, meta())).ok).toBe(false);
    const second = await login({ email: a.email, password: "Sup3r-Secret-Pass" }, meta());
    if (!second.mfa) throw new Error("expected a challenge");
    const replay = await completeMfaLogin(second.challenge.token, { code }, meta());
    expect(replay).toMatchObject({ ok: false, error: "auth.mfa.codeMismatch" });
    expect(await db.session.count({ where: { userId: a.userId } })).toBe(before + 1);
  });

  it("MFA-2 five wrong codes end the challenge and count toward the account lockout", async () => {
    const a = await createAgency("MFA2");
    captureMail();
    const secret = await enrol(a.userId, "Sup3r-Secret-Pass", new Date(Date.now() - 60_000));
    const r = await login({ email: a.email, password: "Sup3r-Secret-Pass" }, meta());
    if (!r.mfa) throw new Error("expected a challenge");
    let token = r.challenge.token;
    for (let i = 1; i <= 5; i++) {
      const res = await completeMfaLogin(token, { code: "000000" }, meta());
      expect(res.ok).toBe(false);
      if (res.ok) return;
      if (i < 5) {
        expect(res.challenge).toBeTruthy();
        token = res.challenge!.token;
      } else {
        expect(res).toMatchObject({ error: "auth.mfa.tooManyAttempts", restart: true });
        expect(res.challenge).toBeUndefined();
      }
    }
    expect((await completeMfaLogin(token, { code: totpCode(secret) }, meta())).ok, "the challenge is gone").toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: a.userId } })).failedLogins).toBe(5);
    // three more wrong passwords reach the existing lockout (8)
    for (let i = 0; i < 3; i++) await expect(login({ email: a.email, password: "nope-nope-nope" }, meta())).rejects.toThrow();
    await expect(login({ email: a.email, password: "Sup3r-Secret-Pass" }, meta())).rejects.toThrow("auth.locked");
  });

  it("MFA-3 a recovery code signs in once, is consumed, and e-mails the account", async () => {
    const a = await createAgency("MFA3");
    captureMail();
    const r = await beginMfaEnrolment(a.userId, "Sup3r-Secret-Pass");
    const { recoveryCodes } = await confirmMfaEnrolment(a.userId, totpCode(r.secret));
    const l1 = await login({ email: a.email, password: "Sup3r-Secret-Pass" }, meta());
    if (!l1.mfa) throw new Error("expected a challenge");
    const ok = await completeMfaLogin(l1.challenge.token, { recoveryCode: recoveryCodes[3].toUpperCase() }, meta());
    expect(ok.ok).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: a.userId } })).mfaRecoveryCodes).toHaveLength(9);
    expect((await systemMail(a.email)).map((m) => m.template)).toContain("recovery_code_used");
    const l2 = await login({ email: a.email, password: "Sup3r-Secret-Pass" }, meta());
    if (!l2.mfa) throw new Error("expected a challenge");
    expect(await completeMfaLogin(l2.challenge.token, { recoveryCode: recoveryCodes[3] }, meta())).toMatchObject({ ok: false, error: "auth.mfa.recoveryMismatch" });
    // regenerating needs the password and a current code; the old codes stop working
    await expect(regenerateRecoveryCodes(a.userId, { password: "Sup3r-Secret-Pass", code: "000000" })).rejects.toThrow();
    const regen = await regenerateRecoveryCodes(a.userId, { password: "Sup3r-Secret-Pass", code: totpCode(r.secret, Date.now() + 30_000) });
    expect(regen.recoveryCodes).toHaveLength(10);
    const l3 = await login({ email: a.email, password: "Sup3r-Secret-Pass" }, meta());
    if (!l3.mfa) throw new Error("expected a challenge");
    expect((await completeMfaLogin(l3.challenge.token, { recoveryCode: recoveryCodes[0] }, meta())).ok).toBe(false);
  });

  it("MFA-4 an org requiring MFA: a director not enrolled for 15 days is enrolment-only; during grace a prompt; enrolled: free", async () => {
    const a = await createAgency("MFA4");
    captureMail();
    expect(readMfaPolicy((await adminDb().organization.findUniqueOrThrow({ where: { id: a.orgId } })).settings).mfaRequired, "new organisations require MFA").toBe(true);
    const dir = await addMember(a.ctx, "ops_director", "Director");
    const emp = await addMember(a.ctx, "employee", "Employee");
    const now = new Date();
    const grace = await mfaGateFor(dir.ctx, null, now);
    expect(grace).toMatchObject({ state: "grace", daysLeft: 14 });
    expect(await mfaGateFor(emp.ctx, null, now), "non-privileged roles are not covered").toEqual({ state: "none" });
    expect(await mfaGateFor(dir.ctx, null, new Date(now.getTime() + 15 * DAY))).toMatchObject({ state: "enforced" });
    // backdate: policy and membership 15 days old → login lands on the enrolment interstitial
    const past = new Date(now.getTime() - 15 * DAY);
    await adminDb().organization.update({ where: { id: a.orgId }, data: { settings: { security: { mfaRequired: true, since: past.toISOString(), includeVip: false } } } });
    await adminDb().membership.updateMany({ where: { organizationId: a.orgId, userId: dir.userId }, data: { joinedAt: past } });
    const ctx = await ctxFor(dir.userId, a.slug);
    expect(await mfaGateFor(ctx, null)).toMatchObject({ state: "enforced" });
    const l = await login({ email: dir.email, password: "Member-Pass-12345" }, meta());
    expect(l.mfa).toBe(false);
    if (!l.mfa) expect(l.redirectTo).toBe(`/mfa-setup?next=${encodeURIComponent(`/o/${a.slug}`)}`);
    // a role change restarts the 14 days
    const s = await enrol(dir.userId, "Member-Pass-12345");
    expect(s).toBeTruthy();
    expect(await mfaGateFor(ctx, (await db.user.findUniqueOrThrow({ where: { id: dir.userId } })).mfaEnabledAt)).toEqual({ state: "none" });
    // the security settings list who is covered
    const sec = await getSecuritySettings(a.ctx);
    expect(sec.members.find((m) => m.userId === dir.userId)?.enrolled).toBe(true);
    expect(sec.members.some((m) => m.userId === emp.userId)).toBe(false);
  });

  it("MFA-5 an admin reset is refused for a user who belongs to two organisations; otherwise clears MFA, revokes sessions, tells owners", async () => {
    const a = await createAgency("MFA5");
    const b = await createAgency("MFA5 other");
    captureMail();
    const emp = await addMember(a.ctx, "employee", "Shared person");
    await enrol(emp.userId, "Member-Pass-12345");
    const mA = await adminDb().membership.findFirstOrThrow({ where: { organizationId: a.orgId, userId: emp.userId } });
    // the same account joins a second organisation
    await withTenant({ orgId: b.orgId, userId: b.userId }, async (tx) => {
      const role = await tx.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: b.orgId, key: "employee" } } });
      await tx.membership.create({ data: { organizationId: b.orgId, userId: emp.userId, roleId: role.id } });
    });
    await expect(adminResetMfa(a.ctx, { membershipId: mA.id, reason: "Lost phone, verified by call" })).rejects.toThrow("auth.mfa.resetMultiOrg");
    await adminDb().membership.updateMany({ where: { organizationId: b.orgId, userId: emp.userId }, data: { status: "REVOKED" } });
    const s = await createSession(emp.userId);
    const dir = await addMember(a.ctx, "ops_director", "Director");
    await expect(adminResetMfa(a.ctx, { membershipId: mA.id, reason: "short" })).rejects.toThrow();
    await adminResetMfa(dir.ctx, { membershipId: mA.id, reason: "Lost phone, verified by call" });
    const u = await db.user.findUniqueOrThrow({ where: { id: emp.userId } });
    expect(u).toMatchObject({ mfaEnabledAt: null, mfaSecretEnc: null, mfaRecoveryCodes: [] });
    expect(await validateSessionToken(s.token)).toBeNull();
    expect((await systemMail(emp.email)).map((m) => m.template)).toContain("mfa_reset");
    expect(await adminDb().notification.count({ where: { organizationId: a.orgId, userId: a.userId, type: "security.mfa_reset" } })).toBe(1);
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "auth.mfa_reset_by_admin" } })).toBe(1);
    // never for oneself; a director never resets an owner
    await enrol(a.userId, "Sup3r-Secret-Pass");
    const ownerM = await adminDb().membership.findFirstOrThrow({ where: { organizationId: a.orgId, userId: a.userId } });
    await expect(adminResetMfa(a.ctx, { membershipId: ownerM.id, reason: "Lost phone, verified by call" })).rejects.toThrow("auth.mfa.resetSelf");
    await expect(adminResetMfa(dir.ctx, { membershipId: ownerM.id, reason: "Lost phone, verified by call" })).rejects.toThrow();
  });

  it("MFA-6 a director in an org requiring MFA can't turn it off; an employee can (password + code)", async () => {
    const a = await createAgency("MFA6");
    captureMail();
    const dir = await addMember(a.ctx, "ops_director", "Director");
    const secret = await enrol(dir.userId, "Member-Pass-12345", new Date(Date.now() - 30_000));
    await expect(disableMfa(dir.userId, { password: "Member-Pass-12345", code: totpCode(secret) })).rejects.toThrow("auth.mfa.requiredByOrg");
    expect((await getMfaStatus(dir.userId)).canDisable).toBe(false);
    const emp = await addMember(a.ctx, "employee", "Employee");
    const es = await enrol(emp.userId, "Member-Pass-12345", new Date(Date.now() - 30_000));
    await expect(disableMfa(emp.userId, { password: "Member-Pass-12345", code: "000000" })).rejects.toThrow();
    await disableMfa(emp.userId, { password: "Member-Pass-12345", code: totpCode(es) });
    expect((await db.user.findUniqueOrThrow({ where: { id: emp.userId } })).mfaEnabledAt).toBeNull();
    expect((await systemMail(emp.email)).map((m) => m.template)).toContain("mfa_disabled");
  });

  it("the org policy is owner-only, audited, and merges into settings without touching other keys", async () => {
    const a = await createAgency("MFAPolicy");
    const dir = await addMember(a.ctx, "ops_director", "Director");
    await adminDb().organization.update({ where: { id: a.orgId }, data: { settings: { approvalSlaHours: 72, security: { mfaRequired: true, since: new Date().toISOString(), includeVip: false } } } });
    await expect(setMfaPolicy(dir.ctx, { mfaRequired: false, includeVip: false })).rejects.toThrow();
    await setMfaPolicy(a.ctx, { mfaRequired: false, includeVip: false });
    let s = (await adminDb().organization.findUniqueOrThrow({ where: { id: a.orgId } })).settings as Record<string, unknown>;
    expect(s.approvalSlaHours).toBe(72);
    expect(readMfaPolicy(s as never).mfaRequired).toBe(false);
    const on = await setMfaPolicy(a.ctx, { mfaRequired: true, includeVip: true });
    expect(on.since).not.toBeNull();
    s = (await adminDb().organization.findUniqueOrThrow({ where: { id: a.orgId } })).settings as Record<string, unknown>;
    expect(readMfaPolicy(s as never)).toMatchObject({ mfaRequired: true, includeVip: true });
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "org.mfa_policy" } })).toBe(2);
    // VIP extension: a PM (vip.viewSensitive) is now covered
    const pm = await addMember(a.ctx, "project_manager", "PM");
    expect((await mfaGateFor(pm.ctx, null)).state).toBe("grace");
  });
});
