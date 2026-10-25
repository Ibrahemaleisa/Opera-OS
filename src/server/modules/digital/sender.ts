import { appBaseUrl } from "@/server/app-url";
import { systemContext } from "@/server/authz/context";
import { db } from "@/server/db/client";
import { withTenant, type Tx } from "@/server/db/tenant";
import type { InvitationCampaign } from "@/generated/prisma/client";
import { audit } from "@/server/modules/audit/audit";
import { notify } from "@/server/modules/notifications/notify";
import { enqueue } from "@/server/jobs/dispatch";
import { NO_CAMPAIGN_LAUNCH_STATUSES } from "@/server/modules/approvals/service";
export { campaignSendState } from "./send-state";
import { ProviderError, resolveProvider } from "./providers";
import { DISPATCH_BATCH, DISPATCH_LEASE_MS, DISPATCH_MAX_ATTEMPTS, LATE_SEND_MS, OUTCOME_UNKNOWN_MS } from "./send-state";
import { issueRsvpToken, personalization, renderTemplate, rsvpTokenExpiry } from "./service";

const APP = appBaseUrl;

/** Grace for clock skew between the scheduler / delayed job and the stored scheduledAt. */
const DUE_TOLERANCE_MS = 60_000;

// ── Dispatch lease and recovery (BUSINESS_RULES §7.2): constants and state in ./send-state ──

const leaseFrom = (now: Date) => new Date(now.getTime() + DISPATCH_LEASE_MS);

/**
 * Creates one MessageJob per queued invitation (idempotency key campaign:invitation:initial) in
 * batches of {@link DISPATCH_BATCH}, renewing the dispatch lease with every batch, and hands each
 * to the sender. Safe to re-run: existing jobs are never duplicated, and a resumed dispatch first
 * re-sends the jobs a crashed run left QUEUED (the send itself is a status compare-and-set).
 *
 * A scheduled send is never released early, is held while the project can't send (§1.6), and is
 * held as "late" when released more than 30 minutes after its time (§7.2 rule 4).
 */
export async function dispatchCampaign(orgId: string, actorId: string, campaignId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const ctx = { ...systemContext(orgId), userId: actorId };
  const claim = await withTenant({ orgId }, async (tx) => {
    const c = await tx.invitationCampaign.findUnique({ where: { id: campaignId } });
    if (!c || !["SENDING", "SCHEDULED"].includes(c.status) || !c.channel) return null;
    // a scheduled campaign is never sent before its time (early delayed job, inline fallback, manual call)
    if (c.status === "SCHEDULED" && c.scheduledAt && c.scheduledAt.getTime() > now.getTime() + DUE_TOLERANCE_MS) return null;
    const project = await tx.project.findUnique({ where: { id: c.projectId }, select: { status: true } });
    // §1.6: DRAFT and ON_HOLD projects hold the send (it stays SCHEDULED; resume handles a passed time,
    // LC rule 8); COMPLETED, CLOSED and CANCELLED never send
    if (!project || (NO_CAMPAIGN_LAUNCH_STATUSES as readonly string[]).includes(project.status)) return null;
    // the approval must still stand (an edit after approval supersedes it and returns the campaign to DRAFT)
    if (!(await tx.approval.findFirst({ where: { entityType: "CAMPAIGN", entityId: c.id, status: "APPROVED" }, select: { id: true } }))) return null;
    if (c.status === "SCHEDULED" && c.scheduledAt && c.scheduledAt.getTime() < now.getTime() - LATE_SEND_MS) {
      await holdLateSend(tx, c, now);
      return null;
    }
    // another dispatch holds a live lease
    if (c.status === "SENDING" && c.dispatchLeaseUntil && c.dispatchLeaseUntil > now) return null;
    const claimed = await tx.invitationCampaign.updateMany({
      where: { id: c.id, status: c.status, dispatchAttempts: c.dispatchAttempts },
      // the lease is bookkeeping; only the SCHEDULED → SENDING release changes the record (and its version)
      data: { status: "SENDING", dispatchLeaseUntil: leaseFrom(now), dispatchAttempts: { increment: 1 }, ...(c.status === "SCHEDULED" ? { version: { increment: 1 } } : {}) },
    });
    if (!claimed.count) return null;
    return { c, attempt: c.dispatchAttempts + 1, resumed: c.status === "SENDING" && c.dispatchAttempts > 0 };
  });
  if (!claim) return { queued: 0, claimed: false };
  const { c } = claim;
  /**
   * Renews the lease inside a batch transaction. The attempt number is the holder's token: a takeover
   * (after expiry) increments it, so this returns false once another dispatch owns the campaign.
   */
  const renew = async (tx: Tx) => {
    const r = await tx.invitationCampaign.updateMany({ where: { id: campaignId, status: "SENDING", dispatchAttempts: claim.attempt }, data: { dispatchLeaseUntil: leaseFrom(new Date(Math.max(Date.now(), now.getTime()))) } });
    return r.count > 0;
  };
  const send = async (ids: string[]) => {
    for (const id of ids) await enqueue("message.send", { orgId, messageJobId: id }, { jobId: `msg-${id}`, attempts: 3, backoff: { type: "exponential", delay: 5000 } });
  };
  let queued = 0;
  // a resumed dispatch first re-sends what a crashed run created but never sent (never a SENDING one)
  if (claim.resumed) {
    for (let cursor: string | undefined; ; ) {
      const page = await withTenant({ orgId }, async (tx) => {
        if (!(await renew(tx))) return null;
        return tx.messageJob.findMany({ where: { invitation: { campaignId }, status: "QUEUED", ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: "asc" }, take: DISPATCH_BATCH, select: { id: true } });
      });
      if (!page) return { queued, claimed: true, lost: true };
      if (!page.length) break;
      await send(page.map((j) => j.id));
      cursor = page[page.length - 1].id;
    }
  }
  const cfg = await withTenant({ orgId }, (tx) => tx.providerConfig.findUnique({ where: { organizationId_channel: { organizationId: orgId, channel: c.channel! } } }));
  const provider = resolveProvider(c.channel!, cfg?.mode ?? "SIMULATION");
  for (;;) {
    const ids = await withTenant({ orgId }, async (tx) => {
      if (!(await renew(tx))) return null;
      const event = c.eventId ? await tx.event.findUnique({ where: { id: c.eventId } }) : await tx.event.findFirst({ where: { projectId: c.projectId }, orderBy: { startsAt: "asc" } });
      const invitations = await tx.digitalInvitation.findMany({ where: { campaignId, status: "QUEUED", messages: { none: {} } }, orderBy: { id: "asc" }, take: DISPATCH_BATCH });
      const suppressed = new Set((await tx.suppressionEntry.findMany({ where: { channel: c.channel!, address: { in: invitations.map((i) => i.address) } } })).map((x) => x.address));
      const recipients = await tx.recipient.findMany({ where: { id: { in: invitations.map((i) => i.recipientId) } } });
      const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { defaultLocale: true } });
      const locale = org.defaultLocale === "en" ? "en" : "ar";
      const out: string[] = [];
      for (const inv of invitations) {
        if (suppressed.has(inv.address)) {
          await tx.digitalInvitation.update({ where: { id: inv.id }, data: { status: "SUPPRESSED" } });
          continue;
        }
        const r = recipients.find((x) => x.id === inv.recipientId);
        if (!r) {
          // recipient removed (e.g. import rolled back): never send, never crash the whole dispatch
          await tx.digitalInvitation.update({ where: { id: inv.id }, data: { status: "FAILED" } });
          continue;
        }
        const token = c.rsvpEnabled ? await issueRsvpToken(tx, orgId, inv, rsvpTokenExpiry(c.rsvpDeadline, event?.endsAt ?? null)) : null;
        const vars = personalization(r, { locale, eventName: event?.name, eventDate: event?.startsAt, rsvpLink: token ? `${APP()}/rsvp/${token}` : "", optOutLink: token ? `${APP()}/rsvp/${token}?optout=1` : "" });
        const body = renderTemplate(c.bodyTemplate ?? "", vars);
        const job = await tx.messageJob.upsert({
          where: { idempotencyKey: `${campaignId}:${inv.id}:initial` },
          create: { organizationId: orgId, invitationId: inv.id, channel: c.channel!, provider: provider.key, simulated: !provider.live, to: inv.address, subject: c.subject ? renderTemplate(c.subject, vars) : null, body, idempotencyKey: `${campaignId}:${inv.id}:initial` },
          update: {},
        });
        await tx.digitalInvitation.update({ where: { id: inv.id }, data: { personalization: vars } });
        out.push(job.id);
      }
      return { out, more: invitations.length === DISPATCH_BATCH };
    }, { timeout: 120_000 });
    if (!ids) return { queued, claimed: true, lost: true };
    await send(ids.out);
    queued += ids.out.length;
    if (!ids.more) break;
  }
  await withTenant({ orgId, userId: actorId }, async (tx) => {
    if (!(await renew(tx))) return;
    const remaining = await tx.messageJob.count({ where: { invitation: { campaignId }, status: { in: ["QUEUED", "SENDING"] } } });
    if (!remaining) await tx.invitationCampaign.updateMany({ where: { id: campaignId, status: "SENDING" }, data: { status: "ACTIVE", dispatchLeaseUntil: null, version: { increment: 1 } } });
    await audit(tx, ctx, { action: "campaign.dispatch", entityType: "CAMPAIGN", entityId: campaignId, projectId: c.projectId, summary: `${queued} messages queued`, meta: { attempt: claim.attempt, resumed: claim.resumed } });
  });
  return { queued, claimed: true };
}

/**
 * Recovery sweep for sends (§7.2), run on every scheduler tick:
 *  1. a message in SENDING for more than 10 minutes has an unknown outcome — a LIVE one becomes FAILED
 *     `outcome_unknown` and is never re-sent automatically; a SIMULATION one goes back to QUEUED;
 *  2. a SENDING campaign whose lease expired with work left is resumed (dispatch attempts < 5) or, at 5,
 *     reported as stalled (one mandatory notice to the launcher and PMs);
 *  3. a scheduled send more than 30 minutes late is held (one mandatory notice).
 * Campaigns of projects that can't send (draft, on hold) are held by §1.6, not stalled.
 */
export async function recoverStalledSends(orgId: string, now = new Date()) {
  const out = { resumed: 0, failed: 0, held: 0, stalled: 0 };
  const stuck = await withTenant({ orgId }, (tx) => tx.messageJob.findMany({ where: { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - OUTCOME_UNKNOWN_MS) } }, select: { id: true, simulated: true, invitationId: true }, take: 500 }));
  for (const j of stuck) {
    const failed = await withTenant({ orgId }, async (tx) => {
      if (j.simulated) {
        await tx.messageJob.updateMany({ where: { id: j.id, status: "SENDING" }, data: { status: "QUEUED" } });
        return false;
      }
      const r = await tx.messageJob.updateMany({ where: { id: j.id, status: "SENDING" }, data: { status: "FAILED", lastError: "outcome_unknown" } });
      if (!r.count) return false;
      if (j.invitationId) await tx.digitalInvitation.update({ where: { id: j.invitationId }, data: { status: "FAILED" } });
      const inv = j.invitationId ? await tx.digitalInvitation.findUnique({ where: { id: j.invitationId }, select: { campaignId: true, projectId: true } }) : null;
      await audit(tx, systemContext(orgId), { action: "message.outcome_unknown", entityType: "CAMPAIGN", entityId: inv?.campaignId ?? null, projectId: inv?.projectId ?? null, summary: j.id });
      return true;
    });
    if (failed) {
      out.failed++;
      await finishCampaignIfDone(orgId, j.invitationId);
    }
  }

  const sending = await withTenant({ orgId }, (tx) =>
    tx.invitationCampaign.findMany({ where: { type: "DIGITAL", status: "SENDING", OR: [{ dispatchLeaseUntil: { lt: now } }, { dispatchLeaseUntil: null, updatedAt: { lt: new Date(now.getTime() - DISPATCH_LEASE_MS) } }] }, take: 20 }),
  );
  for (const c of sending) {
    const step = await withTenant({ orgId }, async (tx) => {
      const project = await tx.project.findUnique({ where: { id: c.projectId }, select: { status: true } });
      if (!project || (NO_CAMPAIGN_LAUNCH_STATUSES as readonly string[]).includes(project.status)) return "held" as const;
      const work = (await tx.messageJob.count({ where: { invitation: { campaignId: c.id }, status: "QUEUED" } })) + (await tx.digitalInvitation.count({ where: { campaignId: c.id, status: "QUEUED", messages: { none: {} } } }));
      if (!work) {
        if (!(await tx.messageJob.count({ where: { invitation: { campaignId: c.id }, status: "SENDING" } }))) await tx.invitationCampaign.updateMany({ where: { id: c.id, status: "SENDING" }, data: { status: "ACTIVE", dispatchLeaseUntil: null, version: { increment: 1 } } });
        return "done" as const;
      }
      if (c.dispatchAttempts < DISPATCH_MAX_ATTEMPTS) return { launcher: await launcherOf(tx, c) };
      await notify(tx, {
        orgId,
        userIds: [await launcherOf(tx, c), ...(await projectManagers(tx, c.projectId))],
        type: "campaign.dispatch_stalled",
        titleKey: "notif.types.campaignStalled",
        params: { name: c.name },
        link: `/projects/${c.projectId}/digital/${c.id}`,
        entityType: "CAMPAIGN",
        entityId: c.id,
        dedupeKey: `campaign.dispatch_stalled:${c.id}:${c.dispatchAttempts}`,
        priority: "HIGH",
        mandatory: true,
      });
      const summary = `stalled after ${c.dispatchAttempts} attempts`;
      if (!(await tx.auditEvent.findFirst({ where: { entityType: "CAMPAIGN", entityId: c.id, action: "campaign.dispatch_stalled", summary }, select: { id: true } }))) {
        await audit(tx, systemContext(orgId), { action: "campaign.dispatch_stalled", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary, meta: { attempts: c.dispatchAttempts } });
      }
      return "stalled" as const;
    });
    if (step === "stalled") out.stalled++;
    else if (typeof step === "object") {
      const r = await dispatchCampaign(orgId, step.launcher, c.id, { now }).catch((e) => {
        console.error(`[recovery] dispatch ${c.id}`, (e as Error).message);
        return { claimed: false };
      });
      if (r.claimed) out.resumed++;
    }
  }

  const late = await withTenant({ orgId }, (tx) => tx.invitationCampaign.findMany({ where: { type: "DIGITAL", status: "SCHEDULED", scheduledAt: { lt: new Date(now.getTime() - LATE_SEND_MS) } }, take: 50 }));
  for (const c of late) {
    const held = await withTenant({ orgId }, async (tx) => {
      const project = await tx.project.findUnique({ where: { id: c.projectId }, select: { status: true } });
      // a send held by an on-hold project is handled on resume (LC rule 8), not reported as late
      if (!project || (NO_CAMPAIGN_LAUNCH_STATUSES as readonly string[]).includes(project.status)) return false;
      await holdLateSend(tx, c, now);
      return true;
    });
    if (held) out.held++;
  }
  return out;
}

/** Who launched the campaign (the latest launch or schedule in the audit trail), else its approver or creator. */
async function launcherOf(tx: Tx, c: Pick<InvitationCampaign, "id" | "approvedById" | "createdById">) {
  const a = await tx.auditEvent.findFirst({ where: { entityType: "CAMPAIGN", entityId: c.id, action: { in: ["campaign.launch", "campaign.schedule"] }, actorId: { not: null } }, orderBy: { createdAt: "desc" }, select: { actorId: true } });
  return a?.actorId ?? c.approvedById ?? c.createdById;
}

async function projectManagers(tx: Tx, projectId: string) {
  return (await tx.projectMember.findMany({ where: { projectId, role: "MANAGER" }, select: { userId: true } })).map((m) => m.userId);
}

/**
 * §7.2 rule 4: a release more than 30 minutes after `scheduledAt` sends nothing. The campaign stays
 * SCHEDULED and reads as "late"; the launcher and PMs get one mandatory notice. A new send time (an
 * edit, which voids the approval) is needed to send it.
 */
async function holdLateSend(tx: Tx, c: InvitationCampaign, now: Date) {
  const at = c.scheduledAt!;
  const sent = await notify(tx, {
    orgId: c.organizationId,
    userIds: [await launcherOf(tx, c), ...(await projectManagers(tx, c.projectId))],
    type: "campaign.held_late",
    titleKey: "notif.types.campaignLate",
    params: { name: c.name },
    link: `/projects/${c.projectId}/digital/${c.id}`,
    entityType: "CAMPAIGN",
    entityId: c.id,
    dedupeKey: `campaign.held_late:${c.id}:${at.toISOString()}`,
    priority: "HIGH",
    mandatory: true,
  });
  const logged = await tx.auditEvent.findFirst({ where: { entityType: "CAMPAIGN", entityId: c.id, action: "campaign.held_late", createdAt: { gte: at } }, select: { id: true } });
  if (!logged) await audit(tx, systemContext(c.organizationId), { action: "campaign.held_late", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: c.name, meta: { scheduledAt: at.toISOString(), heldAt: now.toISOString(), minutesLate: Math.round((now.getTime() - at.getTime()) / 60_000) } });
  return sent;
}

/** Sends one message. Idempotent via status compare-and-set; retryable failures throw for BullMQ backoff. */
export async function sendMessageJob(orgId: string, messageJobId: string) {
  const claimed = await withTenant({ orgId }, async (tx) => {
    const job = await tx.messageJob.findUnique({ where: { id: messageJobId }, include: { invitation: { select: { campaignId: true } } } });
    // only a QUEUED job is sent: one found in SENDING has an unknown outcome and is never re-sent here
    // (the recovery sweep fails it after 10 minutes for LIVE providers, §7.2 rule 3)
    if (!job || job.status !== "QUEUED") return null;
    if (job.invitation) {
      // a campaign cancelled while its dispatch was in flight sends nothing more
      const c = await tx.invitationCampaign.findUnique({ where: { id: job.invitation.campaignId }, select: { status: true } });
      if (!c || c.status === "CANCELLED") {
        await tx.messageJob.updateMany({ where: { id: job.id, status: job.status }, data: { status: "CANCELLED" } });
        return null;
      }
    }
    if (job.invitationId) {
      const s = await tx.suppressionEntry.findUnique({ where: { organizationId_channel_address: { organizationId: orgId, channel: job.channel, address: job.to } } });
      if (s) {
        await tx.messageJob.update({ where: { id: job.id }, data: { status: "SUPPRESSED" } });
        await tx.digitalInvitation.update({ where: { id: job.invitationId }, data: { status: "SUPPRESSED" } });
        return null;
      }
    }
    const r = await tx.messageJob.updateMany({ where: { id: job.id, status: job.status }, data: { status: "SENDING", attempts: { increment: 1 } } });
    return r.count ? { ...job, attempts: job.attempts + 1 } : null;
  });
  if (!claimed) return { skipped: true };
  const cfg = await withTenant({ orgId }, (tx) => tx.providerConfig.findUnique({ where: { organizationId_channel: { organizationId: orgId, channel: claimed.channel } } }));
  const provider = resolveProvider(claimed.channel, cfg?.mode ?? "SIMULATION");
  try {
    const res = await provider.send({ to: claimed.to, subject: claimed.subject, body: claimed.body, reference: claimed.attempts > 1 ? `${claimed.id}:retry` : claimed.id });
    await withTenant({ orgId }, async (tx) => {
      await tx.messageJob.update({ where: { id: claimed.id }, data: { status: res.status, providerMessageId: res.providerMessageId, sentAt: new Date(), lastError: null, provider: provider.key, simulated: !provider.live } });
      if (claimed.invitationId) await tx.digitalInvitation.update({ where: { id: claimed.invitationId }, data: { status: res.status } });
    });
    await db.messageRef.upsert({ where: { id: `${provider.key}:${res.providerMessageId}` }, create: { id: `${provider.key}:${res.providerMessageId}`, organizationId: orgId, messageJobId: claimed.id }, update: {} });
    await finishCampaignIfDone(orgId, claimed.invitationId);
    return { sent: true, simulated: !provider.live };
  } catch (e) {
    const retryable = e instanceof ProviderError ? e.retryable : true;
    const exhausted = !retryable || claimed.attempts >= claimed.maxAttempts;
    await withTenant({ orgId }, async (tx) => {
      await tx.messageJob.update({ where: { id: claimed.id }, data: { status: exhausted ? "FAILED" : "QUEUED", lastError: (e as Error).message.slice(0, 500) } });
      if (exhausted && claimed.invitationId) await tx.digitalInvitation.update({ where: { id: claimed.invitationId }, data: { status: "FAILED" } });
    });
    if (exhausted) {
      await finishCampaignIfDone(orgId, claimed.invitationId);
      return { failed: true };
    }
    // inline mode retries immediately (bounded by maxAttempts); queue mode relies on BullMQ backoff
    if (process.env.JOBS_MODE === "inline") return sendMessageJob(orgId, messageJobId);
    throw e;
  }
}

/**
 * Scheduler step: sends SCHEDULED campaigns whose time has come. Idempotent — dispatchCampaign claims
 * each campaign with a SCHEDULED → SENDING compare-and-set, so overlapping ticks send once.
 */
export async function dispatchDueCampaigns(orgId: string, now = new Date()) {
  // sends more than 30 minutes late are held by the recovery sweep (holdLateSends), so they never
  // crowd out the campaigns that are due now
  const due = await withTenant({ orgId }, (tx) =>
    tx.invitationCampaign.findMany({ where: { type: "DIGITAL", status: "SCHEDULED", OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date(now.getTime() + DUE_TOLERANCE_MS), gte: new Date(now.getTime() - LATE_SEND_MS) } }] }, select: { id: true, approvedById: true, createdById: true }, take: 20 }),
  );
  let sent = 0;
  for (const c of due) sent += (await dispatchCampaign(orgId, c.approvedById ?? c.createdById, c.id, { now })).queued;
  return { campaigns: due.length, queued: sent };
}

async function finishCampaignIfDone(orgId: string, invitationId: string | null) {
  if (!invitationId) return;
  await withTenant({ orgId }, async (tx) => {
    const inv = await tx.digitalInvitation.findUnique({ where: { id: invitationId }, select: { campaignId: true } });
    if (!inv) return;
    const pending = await tx.messageJob.count({ where: { invitation: { campaignId: inv.campaignId }, status: { in: ["QUEUED", "SENDING"] } } });
    const unsent = pending ? 1 : await tx.digitalInvitation.count({ where: { campaignId: inv.campaignId, status: "QUEUED", messages: { none: {} } } });
    if (!pending && !unsent) await tx.invitationCampaign.updateMany({ where: { id: inv.campaignId, status: "SENDING" }, data: { status: "ACTIVE", dispatchLeaseUntil: null, version: { increment: 1 } } });
    // every finished message is progress: it keeps a worker-driven send's lease alive (not a record change)
    else await tx.invitationCampaign.updateMany({ where: { id: inv.campaignId, status: "SENDING", dispatchLeaseUntil: { not: null } }, data: { dispatchLeaseUntil: leaseFrom(new Date()) } });
  });
}

/** Applies a verified provider delivery receipt (idempotent per external event id). */
export async function applyProviderEvent(provider: string, ev: { externalId: string; providerMessageId: string; status: "DELIVERED" | "READ" | "FAILED"; error?: string }, payload: unknown) {
  const ref = await db.messageRef.findUnique({ where: { id: `${provider}:${ev.providerMessageId}` } });
  if (!ref) return { ignored: "unknown message" };
  return withTenant({ orgId: ref.organizationId }, async (tx) => {
    // ON CONFLICT DO NOTHING makes concurrent duplicate deliveries idempotent without aborting the transaction
    const inserted = await tx.webhookReceipt.createMany({ data: [{ organizationId: ref.organizationId, provider, externalId: ev.externalId, payload: payload as object, processedAt: new Date() }], skipDuplicates: true });
    if (!inserted.count) return { duplicate: true };
    const job = await tx.messageJob.findUnique({ where: { id: ref.messageJobId } });
    if (!job) return { ignored: "job missing" };
    // never move backwards (READ > DELIVERED > SENT)
    const rank: Record<string, number> = { QUEUED: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: 5 };
    if ((rank[ev.status] ?? 0) <= (rank[job.status] ?? 0) && ev.status !== "FAILED") return { stale: true };
    await tx.messageJob.update({ where: { id: job.id }, data: { status: ev.status, deliveredAt: ev.status === "DELIVERED" ? new Date() : job.deliveredAt, lastError: ev.error ?? job.lastError } });
    if (job.invitationId) await tx.digitalInvitation.update({ where: { id: job.invitationId }, data: { status: ev.status } });
    if (ev.status === "FAILED" && /bounce|invalid|unsubscribe/i.test(ev.error ?? "")) {
      await tx.suppressionEntry.upsert({ where: { organizationId_channel_address: { organizationId: ref.organizationId, channel: job.channel, address: job.to } }, create: { organizationId: ref.organizationId, channel: job.channel, address: job.to, reason: "BOUNCE" }, update: {} });
    }
    return { applied: ev.status };
  });
}
