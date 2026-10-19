import { systemContext } from "@/server/authz/context";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { audit } from "@/server/modules/audit/audit";
import { enqueue } from "@/server/jobs/dispatch";
import { ProviderError, resolveProvider } from "./providers";
import { issueRsvpToken, personalization, renderTemplate } from "./service";

const APP = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

/**
 * Creates one MessageJob per queued invitation (idempotency key campaign:invitation:initial)
 * and enqueues each send. Safe to re-run: existing jobs are not duplicated.
 */
export async function dispatchCampaign(orgId: string, actorId: string, campaignId: string) {
  const ctx = { ...systemContext(orgId), userId: actorId };
  const { jobIds, campaign } = await withTenant({ orgId }, async (tx) => {
    const c = await tx.invitationCampaign.findUnique({ where: { id: campaignId } });
    if (!c || !["SENDING", "SCHEDULED"].includes(c.status) || !c.channel) return { jobIds: [] as string[], campaign: c };
    if (c.status === "SCHEDULED") await tx.invitationCampaign.update({ where: { id: c.id }, data: { status: "SENDING" } });
    const cfg = await tx.providerConfig.findUnique({ where: { organizationId_channel: { organizationId: orgId, channel: c.channel } } });
    const provider = resolveProvider(c.channel, cfg?.mode ?? "SIMULATION");
    const event = c.eventId ? await tx.event.findUnique({ where: { id: c.eventId } }) : await tx.event.findFirst({ where: { projectId: c.projectId }, orderBy: { startsAt: "asc" } });
    const invitations = await tx.digitalInvitation.findMany({ where: { campaignId, status: "QUEUED", messages: { none: {} } } });
    const suppressed = new Set((await tx.suppressionEntry.findMany({ where: { channel: c.channel, address: { in: invitations.map((i) => i.address) } } })).map((s) => s.address));
    const recipients = await tx.recipient.findMany({ where: { id: { in: invitations.map((i) => i.recipientId) } } });
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { defaultLocale: true } });
    const locale = org.defaultLocale === "en" ? "en" : "ar";
    const ids: string[] = [];
    for (const inv of invitations) {
      if (suppressed.has(inv.address)) {
        await tx.digitalInvitation.update({ where: { id: inv.id }, data: { status: "SUPPRESSED" } });
        continue;
      }
      const r = recipients.find((x) => x.id === inv.recipientId)!;
      const token = c.rsvpEnabled ? await issueRsvpToken(tx, orgId, inv, c.rsvpDeadline ?? (event ? new Date(event.endsAt.getTime() + 86400_000) : null)) : null;
      const vars = personalization(r, { locale, eventName: event?.name, eventDate: event?.startsAt, rsvpLink: token ? `${APP()}/rsvp/${token}` : "", optOutLink: token ? `${APP()}/rsvp/${token}?optout=1` : "" });
      const body = renderTemplate(c.bodyTemplate ?? "", vars);
      const job = await tx.messageJob.upsert({
        where: { idempotencyKey: `${campaignId}:${inv.id}:initial` },
        create: { organizationId: orgId, invitationId: inv.id, channel: c.channel, provider: provider.key, simulated: !provider.live, to: inv.address, subject: c.subject ? renderTemplate(c.subject, vars) : null, body, idempotencyKey: `${campaignId}:${inv.id}:initial` },
        update: {},
      });
      await tx.digitalInvitation.update({ where: { id: inv.id }, data: { personalization: vars } });
      ids.push(job.id);
    }
    return { jobIds: ids, campaign: c };
  }, { timeout: 120_000 });
  for (const id of jobIds) await enqueue("message.send", { orgId, messageJobId: id }, { jobId: `msg-${id}`, attempts: 3, backoff: { type: "exponential", delay: 5000 } });
  await withTenant({ orgId, userId: actorId }, async (tx) => {
    const remaining = await tx.messageJob.count({ where: { invitation: { campaignId }, status: { in: ["QUEUED", "SENDING"] } } });
    if (!remaining && campaign) await tx.invitationCampaign.updateMany({ where: { id: campaignId, status: "SENDING" }, data: { status: "ACTIVE" } });
    await audit(tx, ctx, { action: "campaign.dispatch", entityType: "CAMPAIGN", entityId: campaignId, projectId: campaign?.projectId, summary: `${jobIds.length} messages queued` });
  });
  return { queued: jobIds.length };
}

/** Sends one message. Idempotent via status compare-and-set; retryable failures throw for BullMQ backoff. */
export async function sendMessageJob(orgId: string, messageJobId: string) {
  const claimed = await withTenant({ orgId }, async (tx) => {
    const job = await tx.messageJob.findUnique({ where: { id: messageJobId } });
    if (!job || !["QUEUED", "SENDING"].includes(job.status)) return null;
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

async function finishCampaignIfDone(orgId: string, invitationId: string | null) {
  if (!invitationId) return;
  await withTenant({ orgId }, async (tx) => {
    const inv = await tx.digitalInvitation.findUnique({ where: { id: invitationId }, select: { campaignId: true } });
    if (!inv) return;
    const pending = await tx.messageJob.count({ where: { invitation: { campaignId: inv.campaignId }, status: { in: ["QUEUED", "SENDING"] } } });
    if (!pending) await tx.invitationCampaign.updateMany({ where: { id: inv.campaignId, status: "SENDING" }, data: { status: "ACTIVE" } });
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
