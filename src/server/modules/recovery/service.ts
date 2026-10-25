import type { ServiceContext } from "@/server/authz/context";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { withTenant } from "@/server/db/tenant";
import { audit } from "@/server/modules/audit/audit";
import { importLeaseState, recoverStalledImports } from "@/server/modules/delivery/imports/service";
import { campaignSendState, recoverStalledSends } from "@/server/modules/digital/sender";

/**
 * Stalled-work recovery (BUSINESS_RULES §7), called by the scheduler for every organisation on each
 * tick: imports whose processing lease expired are resumed or given up (§7.1); sends are resumed,
 * reported stalled, held as late, and messages of unknown outcome are failed (§7.2).
 */
export async function recoverStalledWork(orgId: string, now = new Date()): Promise<{ resumed: number; failed: number; held: number }> {
  const imports = await recoverStalledImports(orgId, now);
  const sends = await recoverStalledSends(orgId, now);
  return { resumed: imports.resumed + sends.resumed, failed: imports.failed + sends.failed, held: sends.held };
}

// ── System health (§7.4) ────────────────────────────────────────────────────

export type HealthLevel = "ok" | "info" | "warning" | "critical";
const DAY = 86_400_000;
/** Outbox events are dead after this many attempts (§7.3, automation engine). */
const DEAD_EVENT_ATTEMPTS = 5;

/** Owners and operations directors (§7.4). */
export function canViewSystemHealth(ctx: Pick<ServiceContext, "role" | "permissions">) {
  return ctx.role === "OWNER" || ctx.role === "OPS_DIRECTOR" || ctx.permissions.has("*");
}

function level(n: number, warnAt: number, criticalAt?: number): HealthLevel {
  if (criticalAt !== undefined && n >= criticalAt) return "critical";
  return n >= warnAt ? "warning" : "ok";
}

/**
 * Scheduler freshness from Stream N's scheduler (§7.4: warning after 15 minutes without a tick,
 * critical after 60; SW-9). Imported lazily: the scheduler itself calls this module on every tick.
 */
async function schedulerHealth(orgId: string | null, now: Date) {
  const s = await import("@/server/modules/automation/scheduler");
  const last = orgId ? await s.lastSchedulerTick(orgId) : await s.lastSchedulerTickAnywhere();
  return s.schedulerFreshness(last, now);
}

/**
 * Everything System health shows, for one organisation. Lists are capped at 50 rows; counts are exact.
 * Message bodies and recipient contacts are never included.
 */
export async function systemHealth(ctx: ServiceContext, now = new Date()) {
  if (!canViewSystemHealth(ctx)) throw new ForbiddenError();
  const scheduler = await schedulerHealth(ctx.orgId, now).catch(() => ({ state: "unknown" as const, lastTickAt: null, ageMinutes: null }));
  const since = new Date(now.getTime() - 7 * DAY);
  const data = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const deadEventsWhere = { processedAt: null, attempts: { gte: DEAD_EVENT_ATTEMPTS } };
    const failedExecWhere = { status: "FAILED" as const, createdAt: { gte: since } };
    const deadDeliveriesWhere = { status: "DEAD", createdAt: { gte: since } };
    const [deadEvents, deadEventCount, failedExec, failedExecCount, deadDeliveries, deadDeliveryCount, failingDeliveryCount] = await Promise.all([
      tx.outboxEvent.findMany({ where: deadEventsWhere, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, type: true, attempts: true, lastError: true, createdAt: true } }),
      tx.outboxEvent.count({ where: deadEventsWhere }),
      tx.automationExecution.findMany({ where: failedExecWhere, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, error: true, attempts: true, createdAt: true, rule: { select: { name: true, key: true } } } }),
      tx.automationExecution.count({ where: failedExecWhere }),
      tx.notificationDelivery.findMany({ where: deadDeliveriesWhere, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, template: true, channel: true, attempts: true, lastError: true, createdAt: true } }),
      tx.notificationDelivery.count({ where: deadDeliveriesWhere }),
      tx.notificationDelivery.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
    ]);
    const [imports, campaigns, unknownJobs, unknownCount] = await Promise.all([
      tx.importBatch.findMany({
        where: { OR: [{ status: { in: ["VALIDATING", "COMMITTING"] } }, { error: "import.stalled", updatedAt: { gte: since } }] },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: { id: true, projectId: true, fileName: true, status: true, error: true, progress: true, committedRows: true, totalRows: true, leaseUntil: true, attempts: true, updatedAt: true },
      }),
      tx.invitationCampaign.findMany({
        where: { type: "DIGITAL", OR: [{ status: "SENDING" }, { status: "SCHEDULED", scheduledAt: { lt: now } }] },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: { id: true, projectId: true, name: true, status: true, scheduledAt: true, dispatchLeaseUntil: true, dispatchAttempts: true, updatedAt: true },
      }),
      tx.messageJob.findMany({ where: { status: "FAILED", lastError: "outcome_unknown" }, orderBy: { updatedAt: "desc" }, take: 50, select: { id: true, channel: true, provider: true, updatedAt: true, invitation: { select: { campaignId: true, projectId: true } } } }),
      tx.messageJob.count({ where: { status: "FAILED", lastError: "outcome_unknown" } }),
    ]);
    const projectIds = [...new Set([...imports.map((i) => i.projectId), ...campaigns.map((c) => c.projectId)])];
    const projects = await tx.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, code: true, name: true, status: true } });
    const projectOf = (id: string) => projects.find((p) => p.id === id) ?? null;
    const stalledImports = imports
      .map((b) => ({ ...b, project: projectOf(b.projectId), state: importLeaseState(b, now) }))
      .filter((b) => b.state.paused || b.error === "import.stalled");
    const sends = campaigns
      .map((c) => ({ ...c, project: projectOf(c.projectId), state: campaignSendState(c, projectOf(c.projectId)?.status ?? "CANCELLED", now) }))
      .filter((c) => c.state.paused || c.state.stalled || c.state.late);
    return { deadEvents, deadEventCount, failedExec, failedExecCount, deadDeliveries, deadDeliveryCount, failingDeliveryCount, stalledImports, sends, unknownJobs, unknownCount };
  });
  const sendCritical = data.sends.some((s) => s.state.stalled || s.state.late);
  const stalledCount = data.stalledImports.length + data.sends.length;
  let emailSimulated = false;
  try {
    const { smtpConfigured } = await import("@/server/modules/email/transport");
    emailSimulated = !smtpConfigured();
  } catch {
    emailSimulated = false;
  }
  return {
    checkedAt: now,
    scheduler,
    outbox: { count: data.deadEventCount, level: level(data.deadEventCount, 1, 10), rows: data.deadEvents },
    automation: { count: data.failedExecCount, level: level(data.failedExecCount, 1), rows: data.failedExec.map((e) => ({ id: e.id, rule: e.rule.name, error: e.error, attempts: e.attempts, createdAt: e.createdAt })) },
    deliveries: { count: data.deadDeliveryCount, failing: data.failingDeliveryCount, level: level(data.deadDeliveryCount, 1, 10), rows: data.deadDeliveries },
    email: { simulated: emailSimulated, level: (emailSimulated ? "info" : "ok") as HealthLevel },
    stalled: { count: stalledCount, level: (sendCritical ? "critical" : stalledCount ? "warning" : "ok") as HealthLevel, imports: data.stalledImports, sends: data.sends },
    outcomeUnknown: { count: data.unknownCount, level: level(data.unknownCount, 1), rows: data.unknownJobs.map((j) => ({ id: j.id, channel: j.channel, provider: j.provider, updatedAt: j.updatedAt, campaignId: j.invitation?.campaignId ?? null, projectId: j.invitation?.projectId ?? null })) },
  };
}

export type SystemHealth = Awaited<ReturnType<typeof systemHealth>>;

/** §7.3: a dead outbox event gets its attempts reset to 0 so the dispatcher picks it up again (audited). */
export async function retryOutboxEvent(ctx: ServiceContext, eventId: string) {
  if (!canViewSystemHealth(ctx)) throw new ForbiddenError();
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const e = await tx.outboxEvent.findUnique({ where: { id: eventId } });
    if (!e || e.processedAt || e.attempts < DEAD_EVENT_ATTEMPTS) throw new NotFoundError();
    const r = await tx.outboxEvent.updateMany({ where: { id: e.id, processedAt: null, attempts: e.attempts }, data: { attempts: 0, lastError: null } });
    if (r.count) await audit(tx, ctx, { action: "system.outbox_retry", entityType: "OUTBOX_EVENT", entityId: e.id, summary: e.type, meta: { attempts: e.attempts, lastError: e.lastError } });
    return { retried: r.count > 0 };
  });
}

/**
 * Public liveness counts for `/api/health`: totals across organisations, never tenant data
 * (no ids, names or errors).
 */
export async function healthCounts(now = new Date()) {
  const { adminDb } = await import("@/server/db/admin");
  const db = adminDb();
  const since = new Date(now.getTime() - 7 * DAY);
  const leaseCutoff = new Date(now.getTime() - 120_000);
  const scheduler = await schedulerHealth(null, now).catch(() => null);
  const [deadEvents, failedExecutions, deadDeliveries, stalledImports, stalledSends, lateSends, outcomeUnknown] = await Promise.all([
    db.outboxEvent.count({ where: { processedAt: null, attempts: { gte: DEAD_EVENT_ATTEMPTS } } }),
    db.automationExecution.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
    db.notificationDelivery.count({ where: { status: "DEAD", createdAt: { gte: since } } }),
    db.importBatch.count({ where: { status: { in: ["VALIDATING", "COMMITTING"] }, OR: [{ leaseUntil: { lt: now } }, { leaseUntil: null, updatedAt: { lt: leaseCutoff } }] } }),
    db.invitationCampaign.count({ where: { status: "SENDING", OR: [{ dispatchLeaseUntil: { lt: now } }, { dispatchLeaseUntil: null, updatedAt: { lt: leaseCutoff } }] } }),
    db.invitationCampaign.count({ where: { status: "SCHEDULED", scheduledAt: { lt: new Date(now.getTime() - 30 * 60_000) } } }),
    db.messageJob.count({ where: { status: "FAILED", lastError: "outcome_unknown" } }),
  ]);
  return { scheduler: scheduler ? { state: scheduler.state, ageMinutes: scheduler.ageMinutes } : null, deadEvents, failedExecutions, deadDeliveries, stalledImports, stalledSends, lateSends, outcomeUnknown };
}
