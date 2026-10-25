import type { Prisma } from "@/generated/prisma/client";
import type { OrgRole } from "@/generated/prisma/enums";
import type { Tx } from "@/server/db/tenant";
import { emailPolicyFor, type NotificationPriority } from "./types";

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
  /**
   * Identifies the occurrence (BUSINESS_RULES §3.3 rule 2). The same key for the same user creates
   * nothing the second time; the stored key is `‹dedupeKey›:‹userId›` (unique per organisation).
   */
  dedupeKey?: string;
  priority?: NotificationPriority;
  /** ignores the user's opt-outs (in-app and, when the type has e-mail, e-mail too) — §3.2 "M" */
  mandatory?: boolean;
  /** escalation tier carried by the notice (1 = owner reminded, 2+ = escalated) */
  escalationLevel?: number;
}

/** Which surface a recipient opens links in (e-mail deep links are built from it). */
export type Surface = "o" | "portal" | "vendor" | "field";

function surfaceOf(role: OrgRole): Surface {
  if (role === "CLIENT" || role === "CLIENT_APPROVER") return "portal";
  if (role === "VENDOR") return "vendor";
  if (role === "FIELD_AGENT") return "field";
  return "o";
}

/** What a NotificationDelivery row carries to render the e-mail later. Never VIP contact data. */
export interface NotificationEmailParams {
  type: string;
  titleKey: string;
  params: Record<string, string | number | null>;
  link: string | null;
  surface: Surface;
  priority: NotificationPriority;
  escalationLevel: number;
}

/**
 * Creates in-app notices (and their e-mail outbox rows) in the caller's transaction.
 *
 * - Recipients are active members only (§3.1 rule 4); "system" and `excludeUserId` are dropped.
 * - In-app: per-user preference (type-specific, else "*"), ignored for mandatory notices.
 * - Dedupe: with `dedupeKey`, a repeat for the same user is a no-op (unique index, ON CONFLICT DO NOTHING).
 * - E-mail: decided here from the type registry (§3.2) and the user's e-mail preference; one
 *   `NotificationDelivery` (PENDING) per new notice, written in the same transaction, sent after commit.
 *
 * Returns the number of notices created.
 */
export async function notify(tx: Tx, input: NotifyInput): Promise<number> {
  const ids = [...new Set(input.userIds.filter((x): x is string => !!x && x !== input.excludeUserId && x !== "system"))];
  if (!ids.length) return 0;
  const members = await tx.membership.findMany({
    where: { organizationId: input.orgId, userId: { in: ids }, status: "ACTIVE" },
    select: { userId: true, role: { select: { baseRole: true } } },
  });
  const active = new Map(members.map((m) => [m.userId, m.role.baseRole]));
  const recipients = ids.filter((id) => active.has(id));
  if (!recipients.length) return 0;

  const priority = input.priority ?? "NORMAL";
  const policy = emailPolicyFor(input.type, priority);
  const mandatoryType = policy === "mandatory";
  const prefs = await tx.notificationPreference.findMany({
    where: { organizationId: input.orgId, userId: { in: recipients }, type: { in: [input.type, "*"] } },
  });
  const pref = (userId: string) => ({
    specific: prefs.find((p) => p.userId === userId && p.type === input.type),
    global: prefs.find((p) => p.userId === userId && p.type === "*"),
  });
  const forced = input.mandatory === true || mandatoryType;
  const targets = forced ? recipients : recipients.filter((id) => {
    const { specific, global } = pref(id);
    return (specific ?? global)?.inApp !== false;
  });
  if (!targets.length) return 0;

  const created = await tx.notification.createManyAndReturn({
    data: targets.map((userId) => ({
      organizationId: input.orgId,
      userId,
      type: input.type,
      title: input.titleKey,
      body: input.params ? JSON.stringify(input.params) : null,
      link: input.link ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${userId}` : null,
      priority,
      escalationLevel: input.escalationLevel ?? 0,
    })),
    skipDuplicates: true,
    select: { id: true, userId: true, dedupeKey: true },
  });
  if (!created.length || policy === "none" || policy === "digest") return created.length;

  const wantsEmail = (userId: string) => {
    if (forced) return true;
    const { specific, global } = pref(userId);
    if (specific) return specific.email;
    // "*" is a master switch for optional e-mail: off turns every optional e-mail off
    if (global && global.email === false) return false;
    return policy === "opt_on";
  };
  const emailTo = created.filter((n) => wantsEmail(n.userId));
  if (!emailTo.length) return created.length;
  const users = await tx.user.findMany({ where: { id: { in: emailTo.map((n) => n.userId) } }, select: { id: true, email: true, locale: true } });
  const rows: Prisma.NotificationDeliveryCreateManyInput[] = [];
  for (const n of emailTo) {
    const u = users.find((x) => x.id === n.userId);
    if (!u?.email) continue; // no address: nothing to send (§3.3 SUPPRESSED is for send-time changes)
    const params: NotificationEmailParams = {
      type: input.type,
      titleKey: input.titleKey,
      params: input.params ?? {},
      link: input.link ?? null,
      surface: surfaceOf(active.get(n.userId)!),
      priority,
      escalationLevel: input.escalationLevel ?? 0,
    };
    rows.push({
      organizationId: input.orgId,
      notificationId: n.id,
      userId: n.userId,
      channel: "EMAIL",
      to: u.email,
      template: "notification",
      params: params as unknown as Prisma.InputJsonValue,
      locale: u.locale === "en" ? "en" : "ar",
      dedupeKey: `${n.dedupeKey ?? `notif:${n.id}`}:email`,
    });
  }
  if (rows.length) await tx.notificationDelivery.createMany({ data: rows, skipDuplicates: true });
  return created.length;
}
