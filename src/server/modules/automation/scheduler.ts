import { systemContext } from "@/server/authz/context";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { dispatchDueCampaigns } from "@/server/modules/digital/sender";
import { emit } from "./outbox";
import { processOutbox } from "./engine";

/** Archived or paused projects don't nag anyone: no reminders, escalations or "approaching" alerts. */
export const QUIET_PROJECT_STATUSES = ["CLOSED", "CANCELLED", "COMPLETED", "ON_HOLD"] as const;

/**
 * Time-based triggers. Emits each logical event once using a marker in the outbox payload
 * (`dedupeKey`), checked before emitting, so repeated ticks are idempotent.
 */
export async function schedulerTick(now = new Date()) {
  const orgs = await adminDb().organization.findMany({ select: { id: true, slug: true } });
  let emitted = 0;
  for (const org of orgs) {
    emitted += await withTenant({ orgId: org.id }, async (tx) => {
      // one tick per org at a time: the dedupe read below then sees the other tick's events
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`scheduler:${org.id}`}))`;
      const ctx = systemContext(org.id, org.slug);
      const live = { project: { status: { notIn: [...QUIET_PROJECT_STATUSES] } } };
      let n = 0;
      const dueSoon = await tx.task.findMany({
        where: { ...live, statusCategory: { notIn: ["DONE", "CANCELLED"] }, dueAt: { gt: now, lte: new Date(now.getTime() + 24 * 3600_000) }, ownerId: { not: null } },
        select: { id: true, title: true, number: true, projectId: true, ownerId: true, dueAt: true, project: { select: { code: true } } },
        take: 500,
      });
      const overdue = await tx.task.findMany({
        where: { ...live, statusCategory: { notIn: ["DONE", "CANCELLED"] }, dueAt: { lt: now } },
        select: { id: true, title: true, number: true, projectId: true, ownerId: true, dueAt: true, project: { select: { code: true } } },
        take: 500,
      });
      const quiet = (await tx.project.findMany({ where: { status: { in: [...QUIET_PROJECT_STATUSES] } }, select: { id: true } })).map((p) => p.id);
      const events = await tx.event.findMany({
        where: { projectId: { notIn: quiet }, phase: { in: ["PLANNING", "SETUP", "REHEARSAL"] }, startsAt: { gt: now, lte: new Date(now.getTime() + 3 * 86400_000) } },
        select: { id: true, name: true, projectId: true, startsAt: true },
      });
      const day = now.toISOString().slice(0, 10);
      const candidates = [
        ...dueSoon.map((t) => ({ type: "task.due_soon" as const, key: `due_soon:${t.id}:${t.dueAt?.toISOString()}`, payload: { taskId: t.id, projectId: t.projectId, ownerId: t.ownerId, title: t.title, code: `${t.project.code}-${t.number}`, link: `/tasks/${t.id}`, entityType: "TASK", entityId: t.id } })),
        ...overdue.map((t) => ({ type: "task.overdue" as const, key: `overdue:${t.id}:${day}`, payload: { taskId: t.id, projectId: t.projectId, ownerId: t.ownerId, title: t.title, code: `${t.project.code}-${t.number}`, link: `/tasks/${t.id}`, entityType: "TASK", entityId: t.id } })),
        ...events.map((e) => ({ type: "event.approaching" as const, key: `event_approaching:${e.id}`, payload: { eventId: e.id, projectId: e.projectId, title: e.name, link: `/projects/${e.projectId}/events/${e.id}`, entityType: "EVENT", entityId: e.id } })),
      ];
      if (!candidates.length) return 0;
      const existing = await tx.outboxEvent.findMany({
        where: { type: { in: ["task.due_soon", "task.overdue", "event.approaching"] }, createdAt: { gt: new Date(now.getTime() - 8 * 86400_000) } },
        select: { payload: true },
      });
      const seen = new Set(existing.map((e) => (e.payload as { dedupeKey?: string })?.dedupeKey).filter(Boolean));
      for (const c of candidates) {
        if (seen.has(c.key)) continue;
        await emit(tx, ctx, c.type, { ...c.payload, dedupeKey: c.key });
        n++;
      }
      return n;
    });
    if (emitted) await processOutbox(org.id);
    await dispatchDueCampaigns(org.id, now);
  }
  return { orgs: orgs.length, emitted };
}
