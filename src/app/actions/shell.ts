"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import { globalSearch } from "@/server/modules/search/service";
import { listNotifications, markNotificationsRead, savePreference } from "@/server/modules/notifications/service";

export const searchAction = orgAction(z.object({ q: z.string().trim().min(1).max(100) }), (ctx, i) => globalSearch(ctx, i.q));
export const notificationsAction = orgAction(z.object({ unreadOnly: z.boolean().default(false) }), (ctx, i) => listNotifications(ctx, { unreadOnly: i.unreadOnly, take: 20 }));
export const markReadAction = orgAction(z.object({ ids: z.array(z.string()).optional() }), (ctx, i) => markNotificationsRead(ctx, i.ids));
export const savePreferenceAction = orgAction(
  z.object({ type: z.string().min(1).max(60), inApp: z.boolean(), email: z.boolean(), digest: z.enum(["none", "daily", "weekly"]) }),
  (ctx, i) => savePreference(ctx, i),
);
