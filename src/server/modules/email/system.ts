import { after } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db/client";
import { EMAIL_BACKOFF_MS, MAX_EMAIL_ATTEMPTS, SENDING_STALE_MS } from "@/server/modules/notifications/delivery";
import { MailError, sendMail, smtpConfigured } from "./transport";
import { renderSystemEmail, type SystemTemplate } from "./templates";

/**
 * Account security mail (password reset, password changed, MFA changes): global `SystemEmail` rows,
 * mandatory for the account itself (BUSINESS_RULES §3.2, §5). A row never holds a secret: the reset
 * link is passed in memory to the one send and is not persisted, so a failed reset e-mail is not
 * retried (the user requests a new link). The other templates carry no secret and are retried by the
 * scheduler with the same backoff as notification e-mail.
 */

export interface SystemEmailInput {
  userId: string | null;
  to: string;
  template: SystemTemplate;
  locale: string;
  /** render parameters (time, ip, counts) — never a secret */
  params: Record<string, string | number | null>;
  dedupeKey: string;
}

/** Records a system e-mail (PENDING). Returns its id, or null when the dedupe key already exists. */
export async function createSystemEmail(input: SystemEmailInput): Promise<string | null> {
  const rows = await db.systemEmail.createManyAndReturn({
    data: [{ userId: input.userId, to: input.to, template: input.template, locale: input.locale === "en" ? "en" : "ar", params: input.params as Prisma.InputJsonValue, dedupeKey: input.dedupeKey }],
    skipDuplicates: true,
    select: { id: true },
  });
  return rows[0]?.id ?? null;
}

/** PENDING (never tried) is always due; FAILED waits for its backoff; SENDING is reclaimed when stale. */
function dueWhere(now: Date) {
  return { OR: [{ status: "PENDING" }, { status: "FAILED", nextAttemptAt: { lte: now } }, { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - SENDING_STALE_MS) } }] };
}

/** Templates whose content needs a secret that is not stored: one attempt only. */
const SINGLE_SHOT: ReadonlySet<SystemTemplate> = new Set(["password_reset"]);

/**
 * Sends one system e-mail now (claim → send → record). `secret` (the reset link) is rendered into
 * this one message only. Without SMTP the row ends SIMULATED; outside production the reset link is
 * then printed to the server console so the flow can be exercised locally (§3.3 rule 4).
 */
export async function deliverSystemEmail(id: string, secret?: { link?: string }, now = new Date()): Promise<string> {
  const claimed = await db.systemEmail.updateMany({
    where: { id, ...dueWhere(now) },
    data: { status: "SENDING", attempts: { increment: 1 }, updatedAt: now },
  });
  if (!claimed.count) return "skipped";
  const row = await db.systemEmail.findUniqueOrThrow({ where: { id } });
  const template = row.template as SystemTemplate;
  const singleShot = SINGLE_SHOT.has(template);
  if (singleShot && !secret?.link) {
    // the link only ever existed in the request that created this row
    await db.systemEmail.updateMany({ where: { id, status: "SENDING" }, data: { status: "DEAD", lastError: "link_not_available" } });
    return "DEAD";
  }
  const locale = row.locale === "en" ? "en" : "ar";
  const mail = renderSystemEmail(locale, template, row.params as Record<string, string | number | null>, secret);
  if (!smtpConfigured()) {
    if (secret?.link && process.env.NODE_ENV !== "production") console.info(`[email:simulated] ${template} for system e-mail ${row.id}: ${secret.link}`);
    await db.systemEmail.updateMany({ where: { id, status: "SENDING" }, data: { status: "SIMULATED", lastError: null } });
    return "SIMULATED";
  }
  try {
    const r = await sendMail({ to: row.to, subject: mail.subject, text: mail.text, html: mail.html, reference: row.id });
    await db.systemEmail.updateMany({ where: { id, status: "SENDING" }, data: { status: "SENT", sentAt: now, providerMessageId: r.providerMessageId.slice(0, 300), lastError: null } });
    return "SENT";
  } catch (e) {
    const err = e instanceof MailError ? e : new MailError(String((e as Error).message), false);
    const dead = singleShot || err.permanent || row.attempts >= MAX_EMAIL_ATTEMPTS;
    await db.systemEmail.updateMany({
      where: { id, status: "SENDING" },
      data: dead ? { status: "DEAD", lastError: err.message.slice(0, 500) } : { status: "FAILED", lastError: err.message.slice(0, 500), nextAttemptAt: new Date(now.getTime() + EMAIL_BACKOFF_MS[row.attempts - 1]) },
    });
    return dead ? "DEAD" : "FAILED";
  }
}

/** Scheduler sweep: retries due system e-mail that carries no secret; abandons stuck reset mail. */
export async function sendDueSystemEmails(now = new Date(), limit = 100): Promise<number> {
  const due = await db.systemEmail.findMany({
    where: dueWhere(now),
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let n = 0;
  for (const { id } of due) {
    await deliverSystemEmail(id, undefined, now);
    n++;
  }
  return n;
}

/**
 * Runs `fn` after the response when inside a request (so the response timing doesn't depend on SMTP
 * or on whether an account exists), or awaits it directly elsewhere (scripts, tests).
 */
export async function afterResponse(fn: () => Promise<unknown>): Promise<void> {
  try {
    after(async () => {
      try {
        await fn();
      } catch (e) {
        console.error("[email] deferred send failed", (e as Error).message);
      }
    });
  } catch {
    await fn();
  }
}
