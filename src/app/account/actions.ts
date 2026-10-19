"use server";

import { cookies } from "next/headers";
import { LOCALE_COOKIE } from "@/lib/i18n";
import { changePassword, passwordSchema, profileSchema, updateProfile } from "@/server/auth/account";
import { toActionError, zodFieldErrors, type ActionResult } from "@/server/action";
import { getSession } from "@/server/request";

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
