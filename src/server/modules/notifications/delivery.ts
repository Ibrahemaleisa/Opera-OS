import type { NotificationDelivery } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan } from "@/server/authz/policy";
import { adminDb } from "@/server/db/admin";
import { withTenant, type Tx } from "@/server/db/tenant";
import { NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { MailError, sendMail, smtpConfigured } from "@/server/modules/email/transport";
import { renderDigestEmail, renderNotificationEmail } from "@/server/modules/email/templates";
import type { DigestEmailParams } from "./digest";
import type { NotificationEmailParams } from "./notify";
import { emailPolicyFor } from "./types";

/**
 * E-mail delivery for notices (BUSINESS_RULES §3.3).
 *
 * A NotificationDelivery is written PENDING in the transaction that created the notice. A sender
 * (the request's `after()` kick, the worker, or the scheduler tick) claims due rows with a
 * compare-and-set to SENDING, so two concurrent sweeps never send the same row. Outcomes:
 * SENT (accepted by SMTP) · SIMULATED (no transport: rendered, not sent) · FAILED (transient,
 * retried with backoff) · DEAD (permanent error or 5th failure) · SUPPRESSED (recipient inactive,
 * no address, or preference off at send time).
 */

/** Backoff after failure n (1-based): 1 m, 5 m, 30 m, 2 h, (6 h). The 5th failure is DEAD. */
export const EMAIL_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000] as const;
export const MAX_EMAIL_ATTEMPTS = 5;
/** A row left in SENDING this long (crashed sender) may be claimed again. */
export const SENDING_STALE_MS = 10 * 60_000;

export type EmailMode = "LIVE" | "SIMULATION";

/** LIVE only with a transport AND the organisation's e-mail channel set to LIVE (§3.3 rule 4). */
export async function emailMode(tx: Tx): Promise<EmailMode> {
  if (!smtpConfigured()) return "SIMULATION";
  const cfg = await tx.providerConfig.findFirst({ where: { channel: "EMAIL" }, select: { mode: true, enabled: true } });
  return cfg?.mode === "LIVE" && cfg.enabled ? "LIVE" : "SIMULATION";
}

/** PENDING (never tried, or retried by an admin) is always due; FAILED waits for its backoff; SENDING is reclaimed when stale. */
function dueWhere(now: Date) {
  return {
    OR: [
      { status: "PENDING" },
      { status: "FAILED", nextAttemptAt: { lte: now } },
      { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - SENDING_STALE_MS) } },
    ],
  };
}

export interface SendSummary {
  claimed: number;
  sent: number;
  simulated: number;
  failed: number;
  dead: number;
  suppressed: number;
}

/** Sends this organisation's due e-mail deliveries (bounded per call). Safe to run concurrently. */
export async function sendDueDeliveries(orgId: string, opts: { now?: Date; limit?: number } = {}): Promise<SendSummary> {
  const now = opts.now ?? new Date();
  const summary: SendSummary = { claimed: 0, sent: 0, simulated: 0, failed: 0, dead: 0, suppressed: 0 };
  const due = await withTenant({ orgId }, (tx) =>
    tx.notificationDelivery.findMany({ where: dueWhere(now), orderBy: { nextAttemptAt: "asc" }, take: opts.limit ?? 100, select: { id: true } }),
  );
  if (!due.length) return summary;
  const org = await withTenant({ orgId }, async (tx) => ({
    meta: await tx.organization.findUnique({ where: { id: orgId }, select: { slug: true, name: true, nameEn: true } }),
    mode: await emailMode(tx),
  }));
  for (const { id } of due) {
    // compare-and-set claim: the WHERE is re-checked against the committed row, so only one sender wins
    const claimed = await withTenant({ orgId }, (tx) =>
      tx.notificationDelivery.updateMany({ where: { id, ...dueWhere(now) }, data: { status: "SENDING", attempts: { increment: 1 }, updatedAt: now } }),
    );
    if (!claimed.count) continue;
    summary.claimed++;
    const outcome = await deliverClaimed(orgId, id, now, org.mode, org.meta);
    summary[outcome]++;
  }
  return summary;
}

type Outcome = "sent" | "simulated" | "failed" | "dead" | "suppressed";

async function deliverClaimed(orgId: string, id: string, now: Date, mode: EmailMode, org: { slug: string; name: string; nameEn: string | null } | null): Promise<Outcome> {
  const loaded = await withTenant({ orgId }, async (tx) => {
    const d = await tx.notificationDelivery.findUnique({ where: { id } });
    if (!d) return null;
    const member = await tx.membership.findFirst({ where: { userId: d.userId, status: "ACTIVE" }, select: { id: true } });
    const p = d.params as unknown as NotificationEmailParams;
    const policy = emailPolicyFor(p.type, p.priority);
    let prefOff = false;
    if (policy !== "mandatory") {
      const prefs = await tx.notificationPreference.findMany({ where: { userId: d.userId, type: { in: [p.type, "*"] } } });
      const specific = prefs.find((x) => x.type === p.type);
      const global = prefs.find((x) => x.type === "*");
      prefOff = specific ? !specific.email : global?.email === false;
    }
    return { d, p, suppress: !member || !d.to || prefOff };
  });
  if (!loaded) return "dead";
  const { d, p } = loaded;
  const finish = (data: Partial<Pick<NotificationDelivery, "status" | "lastError" | "providerMessageId" | "sentAt" | "nextAttemptAt">>) =>
    withTenant({ orgId }, async (tx) => {
      await tx.notificationDelivery.updateMany({ where: { id, status: "SENDING" }, data });
      if (data.status === "SENT" && d.notificationId) await tx.notification.updateMany({ where: { id: d.notificationId }, data: { emailedAt: data.sentAt } });
    });
  if (loaded.suppress) {
    await finish({ status: "SUPPRESSED", lastError: null });
    return "suppressed";
  }
  const locale = d.locale === "en" ? "en" : "ar";
  const orgCtx = { orgSlug: org?.slug ?? "", orgName: (locale === "en" && org?.nameEn) || org?.name || "" };
  const mail = d.template === "digest" ? renderDigestEmail(locale, p as DigestEmailParams, orgCtx) : renderNotificationEmail(locale, p, orgCtx);
  if (mode === "SIMULATION") {
    // rendered and recorded, never sent and never shown as sent
    await finish({ status: "SIMULATED", lastError: null, sentAt: null });
    return "simulated";
  }
  try {
    const r = await sendMail({ to: d.to, subject: mail.subject, text: mail.text, html: mail.html, reference: d.id });
    await finish({ status: "SENT", providerMessageId: r.providerMessageId.slice(0, 300), sentAt: now, lastError: null });
    return "sent";
  } catch (e) {
    const err = e instanceof MailError ? e : new MailError((e as Error).message ?? "send failed", false);
    const attempts = d.attempts; // already counted by the claim
    if (err.permanent || attempts >= MAX_EMAIL_ATTEMPTS) {
      await finish({ status: "DEAD", lastError: err.message.slice(0, 500) });
      console.warn(`[email] delivery ${d.id} dead after ${attempts} attempt(s)`);
      return "dead";
    }
    await finish({ status: "FAILED", lastError: err.message.slice(0, 500), nextAttemptAt: new Date(now.getTime() + EMAIL_BACKOFF_MS[attempts - 1]) });
    return "failed";
  }
}

/** Org ids with e-mail due now (scheduler/worker discovery; owner connection, ids only). */
export async function orgsWithDueDeliveries(now = new Date()): Promise<string[]> {
  const rows = await adminDb().notificationDelivery.findMany({ where: dueWhere(now), distinct: ["organizationId"], select: { organizationId: true }, take: 500 });
  return rows.map((r) => r.organizationId);
}

// ── Admin: delivery log (Settings → Providers, UX note 3) ─────────────────────

export const DELIVERY_STATUSES = ["PENDING", "SENDING", "SENT", "SIMULATED", "FAILED", "DEAD", "SUPPRESSED"] as const;

/** `r***@domain` — the log never shows full addresses. */
export function maskEmail(to: string): string {
  const [local, domain] = to.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

export async function listDeliveries(ctx: ServiceContext, input: { status?: string | null; q?: string | null; take?: number } = {}) {
  assertCan(ctx, "org.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const q = input.q?.trim();
    const where = {
      ...(input.status === "attention" ? { status: { in: ["FAILED", "DEAD"] } } : input.status && (DELIVERY_STATUSES as readonly string[]).includes(input.status) ? { status: input.status } : {}),
      ...(q ? { OR: [{ to: { contains: q, mode: "insensitive" as const } }, { params: { path: ["type"], string_contains: q } }] } : {}),
    };
    const [rows, counts, mode] = await Promise.all([
      tx.notificationDelivery.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(input.take ?? 100, 300) }),
      tx.notificationDelivery.groupBy({ by: ["status"], _count: true }),
      emailMode(tx),
    ]);
    return {
      mode,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) as Record<string, number>,
      rows: rows.map((r) => {
        const p = r.params as unknown as Partial<NotificationEmailParams>;
        return {
          id: r.id,
          createdAt: r.createdAt,
          to: maskEmail(r.to),
          channel: r.channel,
          type: p.type ?? r.template,
          status: r.status,
          attempts: r.attempts,
          nextAttemptAt: r.nextAttemptAt,
          sentAt: r.sentAt,
          lastError: r.lastError,
          link: p.link ?? null,
        };
      }),
    };
  });
}

/** FAILED / DEAD → PENDING, attempts reset, audited (§7.3). */
export async function retryDelivery(ctx: ServiceContext, input: { id: string }) {
  assertCan(ctx, "org.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const d = await tx.notificationDelivery.findUnique({ where: { id: input.id } });
    if (!d) throw new NotFoundError();
    const r = await tx.notificationDelivery.updateMany({ where: { id: d.id, status: { in: ["FAILED", "DEAD"] } }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null } });
    if (!r.count) throw new ValidationError("errors.invalidTransition");
    await audit(tx, ctx, { action: "notification.delivery_retry", entityType: "NOTIFICATION_DELIVERY", entityId: d.id, summary: `${d.status} → PENDING`, meta: { attempts: d.attempts } });
    return { retried: 1 };
  });
}

/** "Retry all stopped": every DEAD delivery back to PENDING. */
export async function retryAllDead(ctx: ServiceContext) {
  assertCan(ctx, "org.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const r = await tx.notificationDelivery.updateMany({ where: { status: "DEAD" }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null } });
    if (r.count) await audit(tx, ctx, { action: "notification.delivery_retry", entityType: "NOTIFICATION_DELIVERY", summary: `${r.count} DEAD → PENDING`, meta: { count: r.count } });
    return { retried: r.count };
  });
}
