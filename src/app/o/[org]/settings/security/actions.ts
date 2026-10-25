"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import { adminResetMfa } from "@/server/modules/auth/mfa";
import { setMfaPolicy } from "@/server/modules/auth/mfa-policy";
import { sendResetLinkByAdmin } from "@/server/modules/auth/password-reset";

// one switch; the optional VIP-data extension (§5.2) keeps whatever it was (off by default)
export const setMfaPolicyAction = orgAction(z.object({ mfaRequired: z.boolean() }), (ctx, i) => setMfaPolicy(ctx, i));
export const adminResetMfaAction = orgAction(z.object({ membershipId: z.string(), reason: z.string().trim().min(10).max(1000) }), (ctx, i) => adminResetMfa(ctx, i));
export const sendResetLinkAction = orgAction(z.object({ membershipId: z.string() }), (ctx, i) => sendResetLinkByAdmin(ctx, i));
