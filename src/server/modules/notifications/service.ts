import type { ServiceContext } from "@/server/authz/context";
import { withTenant } from "@/server/db/tenant";
import { ValidationError } from "@/server/errors";
import { isMandatoryType } from "./types";

export async function listNotifications(ctx: ServiceContext, opts: { unreadOnly?: boolean; take?: number } = {}) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const [items, unread] = await Promise.all([
      tx.notification.findMany({ where: { userId: ctx.userId, ...(opts.unreadOnly ? { readAt: null } : {}) }, orderBy: { createdAt: "desc" }, take: opts.take ?? 50 }),
      tx.notification.count({ where: { userId: ctx.userId, readAt: null } }),
    ]);
    return { items, unread };
  });
}

export async function unreadCount(ctx: ServiceContext) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => tx.notification.count({ where: { userId: ctx.userId, readAt: null } }));
}

export async function markNotificationsRead(ctx: ServiceContext, ids?: string[]) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const r = await tx.notification.updateMany({ where: { userId: ctx.userId, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } });
    return r.count;
  });
}

export async function listPreferences(ctx: ServiceContext) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => tx.notificationPreference.findMany({ where: { userId: ctx.userId } }));
}

/** Mandatory types (§3.2 "M") can't be switched off: in-app and e-mail stay on. */
export async function savePreference(ctx: ServiceContext, input: { type: string; inApp: boolean; email: boolean; digest: string }) {
  if (input.type !== "*" && isMandatoryType(input.type) && (!input.inApp || !input.email)) throw new ValidationError("notif.mandatoryHint");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx.notificationPreference.upsert({
      where: { organizationId_userId_type: { organizationId: ctx.orgId, userId: ctx.userId, type: input.type } },
      create: { organizationId: ctx.orgId, userId: ctx.userId, ...input },
      update: input,
    }),
  );
}

/** Whether this organisation's e-mail is only simulated (the preference table says so, §3.2 NT rule 3). */
export async function emailChannelState(ctx: ServiceContext): Promise<{ simulated: boolean }> {
  const { emailMode } = await import("./delivery");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => ({ simulated: (await emailMode(tx)) === "SIMULATION" }));
}
