import type { Prisma } from "@/generated/prisma/client";
import { systemContext } from "@/server/authz/context";
import { QUIET_PROJECT_STATUSES } from "@/server/authz/policy";
import { adminDb } from "@/server/db/admin";
import { withTenant, type Tx } from "@/server/db/tenant";
import { dispatchDueCampaigns } from "@/server/modules/digital/sender";
import { sendDueSystemEmails } from "@/server/modules/email/system";
import { sendDueDeliveries } from "@/server/modules/notifications/delivery";
import { recoverStalledWork } from "@/server/modules/recovery/service";
import { emit } from "./outbox";
import { processOutbox } from "./engine";
import { runEscalations } from "./escalation";
import { queueDailyDigests } from "@/server/modules/notifications/digest";

/** Archived or paused projects don't nag anyone (one definition, in authz/policy.ts; re-exported for existing imports). */
export { QUIET_PROJECT_STATUSES };

/**
 * The scheduler tick (BUSINESS_RULES §0, §3.4, §7.4). Production MUST run it at least every 5 minutes
 * (the worker does; serverless deployments call /api/cron/scheduler). It is idempotent and bounded:
 *  - one tick per organisation at a time (a transaction-scoped advisory try-lock: an overlapping tick
 *    skips the organisation instead of queueing behind it);
 *  - each reminder and escalation tier is emitted once per occurrence (dedupe keys and markers);
 *  - every query and send batch has a limit, so a backlog drains over several ticks.
 */
export async function schedulerTick(now = new Date()) {
  const orgs = await adminDb().organization.findMany({ select: { id: true, slug: true, settings: true } });
  let emitted = 0;
  let notices = 0;
  for (const org of orgs) {
    const r = await tickOrganization(org, now);
    emitted += r.emitted;
    notices += r.notices;
  }
  await sendDueSystemEmails(now).catch((e) => console.error("[scheduler] system e-mail failed", (e as Error).message));
  return { orgs: orgs.length, emitted, notices };
}

/** One organisation's share of a tick. Never throws: one organisation's failure doesn't stop the others. */
export async function tickOrganization(org: { id: string; slug: string; settings: Prisma.JsonValue }, now = new Date()): Promise<{ emitted: number; notices: number }> {
  try {
    await recoverStalledWork(org.id, now);
  } catch (e) {
    console.error(`[scheduler] recovery failed for org ${org.id}`, (e as Error).message);
  }
  let emitted = 0;
  let notices = 0;
  try {
    const r = await withTenant(
      { orgId: org.id },
      async (tx) => {
        const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`scheduler:${org.id}`})) AS ok`;
        if (!lock?.ok) return null; // another tick is working on this organisation right now
        const ctx = systemContext(org.id, org.slug);
        const reminders = await emitReminders(tx, ctx, now);
        const esc = await runEscalations(tx, ctx, now, org.settings);
        await queueDailyDigests(tx, org.id, now);
        await recordTick(tx, org.id);
        return { emitted: reminders + esc.events, notices: esc.notices };
      },
      { timeout: 120_000 },
    );
    emitted = r?.emitted ?? 0;
    notices = r?.notices ?? 0;
  } catch (e) {
    console.error(`[scheduler] tick failed for org ${org.id}`, (e as Error).message);
  }
  if (emitted) await processOutbox(org.id).catch((e) => console.error(`[scheduler] outbox failed for org ${org.id}`, (e as Error).message));
  await dispatchDueCampaigns(org.id, now).catch((e) => console.error(`[scheduler] dispatch failed for org ${org.id}`, (e as Error).message));
  await sendDueDeliveries(org.id, { now }).catch((e) => console.error(`[scheduler] e-mail failed for org ${org.id}`, (e as Error).message));
  return { emitted, notices };
}

/**
 * Due-soon (owner, in-app + digest) and event-approaching (PMs) reminders, each once per occurrence:
 * a marker in the outbox payload (`dedupeKey`) is checked before emitting.
 */
async function emitReminders(tx: Tx, ctx: ReturnType<typeof systemContext>, now: Date): Promise<number> {
  const live = { project: { status: { notIn: [...QUIET_PROJECT_STATUSES] } } };
  const dueSoon = await tx.task.findMany({
    where: { ...live, statusCategory: { notIn: ["DONE", "CANCELLED"] }, dueAt: { gt: now, lte: new Date(now.getTime() + 24 * 3600_000) }, ownerId: { not: null } },
    select: { id: true, title: true, number: true, projectId: true, ownerId: true, dueAt: true, project: { select: { code: true } } },
    take: 500,
  });
  const quiet = (await tx.project.findMany({ where: { status: { in: [...QUIET_PROJECT_STATUSES] } }, select: { id: true } })).map((p) => p.id);
  const events = await tx.event.findMany({
    where: { projectId: { notIn: quiet }, phase: { in: ["PLANNING", "SETUP", "REHEARSAL"] }, startsAt: { gt: now, lte: new Date(now.getTime() + 3 * 86400_000) } },
    select: { id: true, name: true, projectId: true, startsAt: true },
    take: 200,
  });
  const candidates = [
    ...dueSoon.map((t) => ({ type: "task.due_soon" as const, key: `due_soon:${t.id}:${t.dueAt?.toISOString()}`, payload: { taskId: t.id, projectId: t.projectId, ownerId: t.ownerId, title: t.title, code: `${t.project.code}-${t.number}`, link: `/tasks/${t.id}`, entityType: "TASK", entityId: t.id } })),
    ...events.map((e) => ({ type: "event.approaching" as const, key: `event_approaching:${e.id}:${e.startsAt.toISOString()}`, payload: { eventId: e.id, projectId: e.projectId, title: e.name, link: `/projects/${e.projectId}/events/${e.id}`, entityType: "EVENT", entityId: e.id } })),
  ];
  if (!candidates.length) return 0;
  const existing = await tx.outboxEvent.findMany({
    where: { type: { in: ["task.due_soon", "event.approaching"] }, createdAt: { gt: new Date(now.getTime() - 8 * 86400_000) } },
    select: { payload: true },
  });
  const seen = new Set(existing.map((e) => (e.payload as { dedupeKey?: string })?.dedupeKey).filter(Boolean));
  let n = 0;
  for (const c of candidates) {
    if (seen.has(c.key)) continue;
    await emit(tx, ctx, c.type, { ...c.payload, dedupeKey: c.key });
    n++;
  }
  return n;
}

// ── Heartbeat (System health §7.4) ───────────────────────────────────────────

/**
 * The tick is recorded per organisation on a disabled system automation row, which the engine never
 * matches (its trigger is not an event type) and the automation settings hide. No schema change.
 */
export const HEARTBEAT_RULE_KEY = "system.scheduler-heartbeat";

async function recordTick(tx: Tx, orgId: string) {
  const conditions = { lastTickAt: new Date().toISOString() } as Prisma.InputJsonValue;
  await tx.automationRule.upsert({
    where: { organizationId_key: { organizationId: orgId, key: HEARTBEAT_RULE_KEY } },
    create: { organizationId: orgId, key: HEARTBEAT_RULE_KEY, name: "نبض المجدول", nameEn: "Scheduler heartbeat", trigger: "system.scheduler.heartbeat", conditions, actions: [], enabled: false, isSystem: true },
    update: { conditions },
  });
}

/** When the scheduler last completed a tick for this organisation (null: never). */
export async function lastSchedulerTick(orgId: string): Promise<Date | null> {
  const row = await withTenant({ orgId }, (tx) => tx.automationRule.findUnique({ where: { organizationId_key: { organizationId: orgId, key: HEARTBEAT_RULE_KEY } }, select: { conditions: true } }));
  const at = (row?.conditions as { lastTickAt?: string } | null)?.lastTickAt;
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** System health thresholds for the scheduler (BUSINESS_RULES §7.4). The tick itself MUST run ≤ every 5 minutes. */
export const SCHEDULER_EXPECTED_INTERVAL_MIN = 5;
export const SCHEDULER_WARNING_AFTER_MIN = 15;
export const SCHEDULER_CRITICAL_AFTER_MIN = 60;

export type SchedulerFreshness = { state: "ok" | "warning" | "critical" | "unknown"; lastTickAt: Date | null; ageMinutes: number | null };

/**
 * Is the scheduler ticking often enough for the escalation timers? "warning" after 15 minutes without a
 * tick, "critical" after 60 (§7.4; SW-9). Ticks that come rarely still fire every tier once — late —
 * but the 15-minute incident and 1-minute e-mail retry timings are then not met.
 */
export function schedulerFreshness(lastTickAt: Date | null, now = new Date()): SchedulerFreshness {
  if (!lastTickAt) return { state: "unknown", lastTickAt: null, ageMinutes: null };
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - lastTickAt.getTime()) / 60_000));
  const state = ageMinutes > SCHEDULER_CRITICAL_AFTER_MIN ? "critical" : ageMinutes > SCHEDULER_WARNING_AFTER_MIN ? "warning" : "ok";
  return { state, lastTickAt, ageMinutes };
}

/** The most recent tick of this deployment, any organisation (for /api/health; owner connection, no tenant data). */
export async function lastSchedulerTickAnywhere(): Promise<Date | null> {
  const row = await adminDb().automationRule.findFirst({ where: { key: HEARTBEAT_RULE_KEY }, orderBy: { updatedAt: "desc" }, select: { conditions: true } });
  const at = (row?.conditions as { lastTickAt?: string } | null)?.lastTickAt;
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}
