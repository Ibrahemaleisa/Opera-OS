"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { revokeSession, revokeSessionById } from "@/server/auth/session-store";
import { LOCALE_COOKIE } from "@/lib/i18n";
import { getSession, requestMeta, SESSION_COOKIE } from "@/server/request";
import { acceptInvitation, login, registerAgency } from "@/server/modules/auth/service";
import { toActionError, type ActionResult } from "@/server/action";
import { sha256Hex } from "@/server/auth/crypto";

async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.COOKIE_SECURE === "true", sameSite: "lax", path: "/", expires: expiresAt });
}

function safeNext(next: unknown): string | null {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : null;
}

export async function loginAction(input: { email: string; password: string; next?: string }): Promise<ActionResult<{ redirectTo: string }>> {
  try {
    const r = await login(input, await requestMeta());
    await setSessionCookie(r.session.token, r.session.expiresAt);
    (await cookies()).set(LOCALE_COOKIE, r.locale === "en" ? "en" : "ar", { path: "/", maxAge: 31536000, sameSite: "lax" });
    return { ok: true, data: { redirectTo: safeNext(input.next) ?? r.redirectTo } };
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
    await setSessionCookie(r.session.token, r.session.expiresAt);
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
