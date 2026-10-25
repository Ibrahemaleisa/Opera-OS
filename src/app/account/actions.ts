"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { LOCALE_COOKIE } from "@/lib/i18n";
import { changePassword, passwordSchema, profileSchema, updateProfile } from "@/server/auth/account";
import { toActionError, zodFieldErrors, type ActionResult } from "@/server/action";
import { getSession, requestMeta } from "@/server/request";
import { beginMfaEnrolment, confirmMfaEnrolment, disableMfa, regenerateRecoveryCodes } from "@/server/modules/auth/mfa";

async function run<T>(fn: (userId: string, sessionId: string) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const s = await getSession();
    if (!s) return { ok: false, code: "UNAUTHENTICATED", error: "errors.forbidden" };
    return { ok: true, data: await fn(s.userId, s.id) };
  } catch (e) {
    return toActionError(e);
  }
}

export async function updateProfileAction(input: unknown): Promise<ActionResult<null>> {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "VALIDATION", error: "errors.validation", fieldErrors: zodFieldErrors(parsed.error) };
  return run(async (userId) => {
    await updateProfile(userId, parsed.data);
    const store = await cookies();
    store.set(LOCALE_COOKIE, parsed.data.locale, { path: "/", maxAge: 31536000, sameSite: "lax" });
    store.set("operra_calendar", parsed.data.calendar, { path: "/", maxAge: 31536000, sameSite: "lax" });
    return null;
  });
}

export async function changePasswordAction(input: unknown): Promise<ActionResult<null>> {
  const parsed = passwordSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "VALIDATION", error: "errors.validation", fieldErrors: zodFieldErrors(parsed.error) };
  return run((userId, sessionId) => changePassword(userId, sessionId, parsed.data));
}

// ── Two-step verification (BUSINESS_RULES §5.2) ──────────────────────────────

const credentials = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(10) });

export async function beginMfaAction(input: { password: string }): Promise<ActionResult<{ secret: string; qr: string }>> {
  const parsed = z.object({ password: z.string().min(1).max(200) }).safeParse(input);
  if (!parsed.success) return { ok: false, code: "VALIDATION", error: "errors.validation", fieldErrors: zodFieldErrors(parsed.error) };
  return run(async (userId) => {
    const r = await beginMfaEnrolment(userId, parsed.data.password);
    return { secret: r.secret, qr: r.qr };
  });
}

export async function confirmMfaAction(input: { code: string }): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const parsed = z.object({ code: z.string().trim().min(6).max(10) }).safeParse(input);
  if (!parsed.success) return { ok: false, code: "VALIDATION", error: "auth.mfa.codeMismatch" };
  return run(async (userId) => confirmMfaEnrolment(userId, parsed.data.code, await requestMeta()));
}

export async function regenerateCodesAction(input: { password: string; code: string }): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const parsed = credentials.safeParse(input);
  if (!parsed.success) return { ok: false, code: "VALIDATION", error: "errors.validation", fieldErrors: zodFieldErrors(parsed.error) };
  return run(async (userId) => regenerateRecoveryCodes(userId, parsed.data, await requestMeta()));
}

export async function disableMfaAction(input: { password: string; code: string }): Promise<ActionResult<null>> {
  const parsed = credentials.safeParse(input);
  if (!parsed.success) return { ok: false, code: "VALIDATION", error: "errors.validation", fieldErrors: zodFieldErrors(parsed.error) };
  return run(async (userId) => disableMfa(userId, parsed.data, await requestMeta()));
}
