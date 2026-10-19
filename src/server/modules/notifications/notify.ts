import type { Tx } from "@/server/db/tenant";

export interface NotifyInput {
  orgId: string;
  userIds: (string | null | undefined)[];
  type: string;
  /** i18n key under `notif.*` */
  titleKey: string;
  params?: Record<string, string | number | null>;
  link?: string;
  entityType?: string;
  entityId?: string;
  excludeUserId?: string | null;
}

/** Creates in-app notifications honoring per-user preferences (type-specific or "*"). */
export async function notify(tx: Tx, input: NotifyInput) {
  const ids = [...new Set(input.userIds.filter((x): x is string => !!x && x !== input.excludeUserId && x !== "system"))];
  if (!ids.length) return 0;
  const prefs = await tx.notificationPreference.findMany({
    where: { organizationId: input.orgId, userId: { in: ids }, type: { in: [input.type, "*"] } },
  });
  const muted = new Set(
    ids.filter((id) => {
      const specific = prefs.find((p) => p.userId === id && p.type === input.type);
      const global = prefs.find((p) => p.userId === id && p.type === "*");
      return (specific ?? global)?.inApp === false;
    }),
  );
  const targets = ids.filter((id) => !muted.has(id));
  if (!targets.length) return 0;
  await tx.notification.createMany({
    data: targets.map((userId) => ({
      organizationId: input.orgId,
      userId,
      type: input.type,
      title: input.titleKey,
      body: input.params ? JSON.stringify(input.params) : null,
      link: input.link ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    })),
  });
  return targets.length;
}
