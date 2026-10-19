"use server";

import { requestMeta } from "@/server/request";
import { toActionError, type ActionResult } from "@/server/action";
import { optOut, rsvpSchema, submitRsvp } from "@/server/modules/digital/service";

export async function submitRsvpAction(input: unknown): Promise<ActionResult<{ response: string }>> {
  try {
    const parsed = rsvpSchema.parse(input);
    return { ok: true, data: await submitRsvp(parsed, (await requestMeta()).ip) };
  } catch (e) {
    return toActionError(e);
  }
}

export async function optOutAction(token: string): Promise<ActionResult<null>> {
  try {
    if (typeof token !== "string") throw new Error("invalid");
    await optOut(token, (await requestMeta()).ip);
    return { ok: true, data: null };
  } catch (e) {
    return toActionError(e);
  }
}
