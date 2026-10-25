"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { revokeSession, revokeSessionById } from "@/server/auth/session-store";
import { LOCALE_COOKIE } from "@/lib/i18n";
import { getSession, requestMeta, safeNextPath, SESSION_COOKIE } from "@/server/request";
import { acceptInvitation, completeMfaLogin, login, registerAgency } from "@/server/modules/auth/service";
import { completePasswordReset, submitForgotPassword } from "@/server/modules/auth/password-reset";
import { toActionError, type ActionResult } from "@/server/action";
import { sha256Hex } from "@/server/auth/crypto";

async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.COOKIE_SECURE === "true", sameSite: "lax", path: "/", expires: expiresAt });
}


// The pending second step of a sign-in (BUSINESS_RULES §5.2): the raw MFA challenge, HttpOnly, 5 minutes.
const MFA_COOKIE = "opera_mfa";

async function setMfaCookie(token: string, expiresAt: Date) {
  (await cookies()).set(MFA_COOKIE, token, { httpOnly: true, secure: process.env.COOKIE_SECURE === "true", sameSite: "strict", path: "/", expires: expiresAt });
}

/** Where to go after sign-in: the requested page, unless MFA enrolment must come first. */
function landing(next: string | undefined, redirectTo: string): string {
  if (redirectTo.startsWith("/mfa-setup") || redirectTo.startsWith("/account?")) {
    const n = safeNextPath(next);
    return n ? `/mfa-setup?next=${encodeURIComponent(n)}` : redirectTo;
  }
  return safeNextPath(next) ?? redirectTo;
}

export async function loginAction(input: { email: string; password: string; next?: string }): Promise<ActionResult<{ redirectTo: string } | { step: "mfa" }>> {
  try {
    const r = await login(input, await requestMeta());
    (await cookies()).set(LOCALE_COOKIE, r.locale === "en" ? "en" : "ar", { path: "/", maxAge: 31536000, sameSite: "lax" });
    if (r.mfa) {
      // no session yet: the second step proves the code
      await setMfaCookie(r.challenge.token, r.challenge.expiresAt);
      return { ok: true, data: { step: "mfa" } };
    }
    await setSessionCookie(r.session.token, r.session.expiresAt);
    return { ok: true, data: { redirectTo: landing(input.next, r.redirectTo) } };
  } catch (e) {
    return toActionError(e);
  }
}

/** Login, second step: a TOTP or a recovery code. A wrong code keeps the step open until the 5th. */
export async function verifyMfaAction(input: { code?: string; recoveryCode?: string; next?: string }): Promise<ActionResult<{ redirectTo: string }> | { ok: false; code: string; error: string; restart: boolean }> {
  try {
    const store = await cookies();
    const token = store.get(MFA_COOKIE)?.value ?? "";
    const r = await completeMfaLogin(token, { code: input.code ?? null, recoveryCode: input.recoveryCode ?? null }, await requestMeta());
    if (!r.ok) {
      if (r.challenge) await setMfaCookie(r.challenge.token, r.challenge.expiresAt);
      else store.delete(MFA_COOKIE);
      return { ok: false, code: r.restart ? "MFA_RESTART" : "MFA_INVALID", error: r.error, restart: r.restart };
    }
    store.delete(MFA_COOKIE);
    await setSessionCookie(r.session.token, r.session.expiresAt);
    return { ok: true, data: { redirectTo: landing(input.next, r.redirectTo) } };
  } catch (e) {
    return { ...toActionError(e), restart: false } as { ok: false; code: string; error: string; restart: boolean };
  }
}

/** Forgot password: always the same answer (no account enumeration, §5.1). */
export async function forgotPasswordAction(input: { email: string }): Promise<ActionResult<null>> {
  try {
    return await submitForgotPassword(input, await requestMeta());
  } catch (e) {
    console.error("[auth] forgot-password failed", (e as Error).message);
    return { ok: true, data: null };
  }
}

export async function resetPasswordAction(input: { token: string; password: string }): Promise<ActionResult<{ redirectTo: string }>> {
  try {
    return { ok: true, data: await completePasswordReset(input, await requestMeta()) };
  } catch (e) {
    return toActionError(e);
  }
}

export async function registerAction(input: { name: string; email: string; password: string; orgName: string; orgSlug: string; locale: "ar" | "en" }): Promise<ActionResult<{ redirectTo: string }>> {
  try {
    const r = await registerAgency(input, await requestMeta());
    await setSessionCookie(r.session.token, r.session.expiresAt);
    return { ok: true, data: { redirectTo: r.redirectTo } };
  } catch (e) {
    return toActionError(e);
  }
}

export async function acceptInviteAction(input: { token: string; name?: string; password: string }): Promise<ActionResult<{ redirectTo: string }>> {
  try {
    const r = await acceptInvitation(input, await requestMeta());
    if (r.session) await setSessionCookie(r.session.token, r.session.expiresAt);
    return { ok: true, data: { redirectTo: r.redirectTo } };
  } catch (e) {
    return toActionError(e);
  }
}

export async function logoutAction() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  store.delete(SESSION_COOKIE);
  store.delete(MFA_COOKIE);
  redirect("/login");
}

export async function revokeDeviceAction(sessionId: string): Promise<ActionResult<null>> {
  const s = await getSession();
  if (!s) return { ok: false, code: "UNAUTHENTICATED", error: "auth.required" };
  await revokeSessionById(sessionId, s.userId);
  return { ok: true, data: null };
}

export async function listMySessions() {
  const s = await getSession();
  if (!s) return [];
  const store = await cookies();
  const current = sha256Hex(store.get(SESSION_COOKIE)?.value ?? "");
  const rows = await db.session.findMany({ where: { userId: s.userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: "desc" } });
  return rows.map((r) => ({ id: r.id, deviceLabel: r.deviceLabel, ip: r.ip, lastSeenAt: r.lastSeenAt, current: r.id === current }));
}

export async function setLocaleAction(locale: "ar" | "en") {
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, { path: "/", maxAge: 31536000, sameSite: "lax" });
  const s = await getSession();
  if (s) await db.user.update({ where: { id: s.userId }, data: { locale } });
}

export async function setCalendarAction(calendar: "gregory" | "islamic-umalqura") {
  const store = await cookies();
  store.set("operra_calendar", calendar, { path: "/", maxAge: 31536000, sameSite: "lax" });
  const s = await getSession();
  if (s) await db.user.update({ where: { id: s.userId }, data: { calendar } });
}
