import type { Prisma } from "@/generated/prisma/client";
import { INTERNAL_ROLES } from "@/server/authz/roles";
import { QUIET_PROJECT_STATUSES } from "@/server/authz/policy";
import type { Tx } from "@/server/db/tenant";
import { resolveApproverSet } from "@/server/modules/approvals/service";
import type { NotificationEmailParams } from "./notify";

/**
 * The daily digest (BUSINESS_RULES §3.2 NT rule 2): one short e-mail per internal active user per day
 * at 07:30 Asia/Riyadh, only when something needs them — work past due that they own, work due today,
 * decisions waiting on them, and mentions since yesterday. Key `digest:‹userId›:‹YYYY-MM-DD›`, so a
 * later or repeated tick that day sends nothing more. It is the only recurring reminder (§3.3 rule 2).
 * Users switch it off with the `digest.daily` e-mail preference (on by default).
 */
export const DIGEST_HOUR = 7;
export const DIGEST_MINUTE = 30;
const RIYADH_OFFSET_MS = 3 * 3600_000; // Asia/Riyadh is UTC+3 all year
const MAX_LINES = 3;

/** The Riyadh calendar day of `now`, as YYYY-MM-DD. */
export function riyadhDay(now: Date): string {
  return new Date(now.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

export function digestDue(now: Date): boolean {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes() >= DIGEST_HOUR * 60 + DIGEST_MINUTE;
}

export interface DigestItem {
  title: string;
  code: string | null;
}

export interface DigestContent {
  overdue: DigestItem[];
  overdueCount: number;
  dueToday: DigestItem[];
  dueTodayCount: number;
  approvals: DigestItem[];
  approvalsCount: number;
  mentions: number;
}

export type DigestEmailParams = NotificationEmailParams & { digest: DigestContent; day: string };

/** Queues today's digests for this organisation (inside the scheduler's tenant transaction). */
export async function queueDailyDigests(tx: Tx, orgId: string, now: Date): Promise<number> {
  if (!digestDue(now)) return 0;
  const day = riyadhDay(now);
  const dayStart = new Date(Date.parse(`${day}T00:00:00Z`) - RIYADH_OFFSET_MS);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
  const done = new Set(
    // (an optimisation: the unique dedupe key is what guarantees one digest per user and day)
    (await tx.notificationDelivery.findMany({ where: { template: "digest", createdAt: { gte: new Date(dayStart.getTime() - 24 * 3600_000) }, dedupeKey: { endsWith: `:${day}` } }, select: { userId: true } })).map((d) => d.userId),
  );
  const members = await tx.membership.findMany({ where: { status: "ACTIVE", role: { baseRole: { in: INTERNAL_ROLES } } }, select: { userId: true } });
  const optedOut = new Set((await tx.notificationPreference.findMany({ where: { type: "digest.daily", email: false }, select: { userId: true } })).map((p) => p.userId));
  const users = members.map((m) => m.userId).filter((u) => !done.has(u) && !optedOut.has(u));
  if (!users.length) return 0;

  const live = { project: { status: { notIn: [...QUIET_PROJECT_STATUSES] } } };
  const open = { statusCategory: { notIn: ["DONE" as const, "CANCELLED" as const] } };
  const [overdue, dueToday, mentions, pending] = await Promise.all([
    tx.task.findMany({ where: { ...live, ...open, ownerId: { in: users }, dueAt: { lt: now } }, select: { ownerId: true, title: true, number: true, project: { select: { code: true } } }, orderBy: { dueAt: "asc" }, take: 2000 }),
    tx.task.findMany({ where: { ...live, ...open, ownerId: { in: users }, dueAt: { gte: now, lt: dayEnd } }, select: { ownerId: true, title: true, number: true, project: { select: { code: true } } }, orderBy: { dueAt: "asc" }, take: 2000 }),
    tx.notification.groupBy({ by: ["userId"], where: { userId: { in: users }, type: "comment.mentioned", createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } }, _count: true }),
    tx.approval.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 200 }),
  ]);
  // decisions waiting on each person: the same notify-set the request used
  const waiting = new Map<string, DigestItem[]>();
  const projects = await tx.project.findMany({ where: { id: { in: [...new Set(pending.map((a) => a.projectId))] }, status: { notIn: ["ON_HOLD", "CLOSED", "CANCELLED"] } } });
  for (const a of pending) {
    const project = projects.find((p) => p.id === a.projectId);
    if (!project) continue;
    for (const u of (await resolveApproverSet(tx, project, a)).notify) if (users.includes(u)) waiting.set(u, [...(waiting.get(u) ?? []), { title: a.title, code: project.code }]);
  }
  const people = await tx.user.findMany({ where: { id: { in: users } }, select: { id: true, email: true, locale: true } });
  const item = (t: { title: string; number: number; project: { code: string } }): DigestItem => ({ title: t.title, code: `${t.project.code}-${t.number}` });
  const rows: Prisma.NotificationDeliveryCreateManyInput[] = [];
  for (const u of people) {
    const mine = overdue.filter((t) => t.ownerId === u.id);
    const today = dueToday.filter((t) => t.ownerId === u.id);
    const appr = waiting.get(u.id) ?? [];
    const ment = mentions.find((m) => m.userId === u.id)?._count ?? 0;
    if (!mine.length && !today.length && !appr.length && !ment) continue; // only when something needs them
    if (!u.email) continue;
    const digest: DigestContent = {
      overdue: mine.slice(0, MAX_LINES).map(item),
      overdueCount: mine.length,
      dueToday: today.slice(0, MAX_LINES).map(item),
      dueTodayCount: today.length,
      approvals: appr.slice(0, MAX_LINES),
      approvalsCount: appr.length,
      mentions: ment,
    };
    const params: DigestEmailParams = { type: "digest.daily", titleKey: "notif.digestMail.heading", params: {}, link: "/my-work", surface: "o", priority: "NORMAL", escalationLevel: 0, digest, day };
    rows.push({ organizationId: orgId, userId: u.id, channel: "EMAIL", to: u.email, template: "digest", params: params as unknown as Prisma.InputJsonValue, locale: u.locale === "en" ? "en" : "ar", dedupeKey: `digest:${u.id}:${day}` });
  }
  if (!rows.length) return 0;
  const r = await tx.notificationDelivery.createMany({ data: rows, skipDuplicates: true });
  return r.count;
}
