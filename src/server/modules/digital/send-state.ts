import type { InvitationCampaign } from "@/generated/prisma/client";
import { NO_CAMPAIGN_LAUNCH_STATUSES } from "@/server/modules/approvals/service";

/** Dispatch lease and recovery constants (BUSINESS_RULES §7.2). */

/** A dispatch holds the campaign for 120 s, renewed with every batch of messages. */
export const DISPATCH_LEASE_MS = 120_000;
/** Messages created and handed to the sender per batch (and per lease renewal). */
export const DISPATCH_BATCH = 200;
/** (Re)starts before a SENDING campaign is reported as stalled. */
export const DISPATCH_MAX_ATTEMPTS = 5;
/** A scheduled send released later than this after its time is held, not sent (§7.2 rule 4). */
export const LATE_SEND_MS = 30 * 60_000;
/** A message in SENDING for longer than this has an unknown outcome (§7.2 rule 3). */
export const OUTCOME_UNKNOWN_MS = 10 * 60_000;

/** What the campaign page and System health show about a send (§7.2, UX note 8). */
export function campaignSendState(c: Pick<InvitationCampaign, "status" | "scheduledAt" | "dispatchLeaseUntil" | "dispatchAttempts" | "updatedAt">, projectStatus: string, now = new Date()) {
  const canSend = !(NO_CAMPAIGN_LAUNCH_STATUSES as readonly string[]).includes(projectStatus);
  const expiry = (c.dispatchLeaseUntil ?? new Date(c.updatedAt.getTime() + DISPATCH_LEASE_MS)).getTime();
  const expired = c.status === "SENDING" && canSend && expiry < now.getTime();
  return {
    late: c.status === "SCHEDULED" && canSend && !!c.scheduledAt && c.scheduledAt.getTime() < now.getTime() - LATE_SEND_MS,
    paused: expired && c.dispatchAttempts < DISPATCH_MAX_ATTEMPTS,
    stalled: expired && c.dispatchAttempts >= DISPATCH_MAX_ATTEMPTS,
    attempts: c.dispatchAttempts,
    maxAttempts: DISPATCH_MAX_ATTEMPTS,
    lastProgressAt: c.updatedAt,
    /** when the recovery sweep will next try (it runs on the scheduler tick after the lease expired) */
    nextAttemptAt: new Date(Math.max(now.getTime(), expiry) + 60_000),
  };
}

