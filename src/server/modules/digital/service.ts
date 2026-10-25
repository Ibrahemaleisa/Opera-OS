import { z } from "zod";
import { appBaseUrl } from "@/server/app-url";
import type { CampaignStatus, Channel, DigitalInvitation, InvitationCampaign, Recipient } from "@/generated/prisma/client";
import { formatDateTime } from "@/lib/format";
import { shortCode } from "@/lib/id";
import { randomToken, sha256Hex } from "@/server/auth/crypto";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan, assertNotArchived, can, projectScope, projectVisibilityWhere } from "@/server/authz/policy";
import { db } from "@/server/db/client";
import { withTenant, type Tx } from "@/server/db/tenant";
import { assertVersion, casUpdate, versionField } from "@/server/concurrency";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { emit } from "@/server/modules/automation/outbox";
import { cancelPendingApprovalsTx, NO_CAMPAIGN_LAUNCH_STATUSES, requestApprovalTx, supersedeApprovalsTx } from "@/server/modules/approvals/service";
import { enqueue } from "@/server/jobs/dispatch";
import { jobsMode } from "@/server/jobs/queue";
import { providerStatus } from "./providers";
import { campaignSendState } from "./send-state";

export { VARIABLES } from "@/lib/digital-vars";

export const digitalCampaignSchema = z.object({
  id: z.string().optional(),
  projectId: z.string(),
  name: z.string().trim().min(2).max(200),
  channel: z.enum(["EMAIL", "SMS", "WHATSAPP"]),
  subject: z.string().trim().max(200).nullish(),
  bodyTemplate: z.string().trim().min(10).max(4000),
  scheduledAt: z.coerce.date().nullish(),
  rsvpEnabled: z.boolean().default(true),
  rsvpDeadline: z.coerce.date().nullish(),
  qrEnabled: z.boolean().default(false),
  eventId: z.string().nullish(),
  version: versionField,
});

function appUrl() {
  return appBaseUrl();
}

/** Renders {{variables}}; unknown variables are left visible so reviewers notice them. */
export function renderTemplate(template: string, vars: Record<string, string | null | undefined>) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, k) => (k in vars ? vars[k] ?? "" : all));
}

export function personalization(r: Pick<Recipient, "nameAr" | "nameEn" | "honorific" | "organizationName" | "jobTitle">, ctx: { locale: "ar" | "en"; eventName?: string | null; eventDate?: Date | null; rsvpLink?: string; optOutLink?: string }) {
  return {
    name: (ctx.locale === "en" ? r.nameEn ?? r.nameAr : r.nameAr ?? r.nameEn) ?? "",
    honorific: r.honorific ?? "",
    organization: r.organizationName ?? "",
    title: r.jobTitle ?? "",
    event_name: ctx.eventName ?? "",
    event_date: ctx.eventDate ? formatDateTime(ctx.eventDate, { locale: ctx.locale }) : "",
    rsvp_link: ctx.rsvpLink ?? "",
    opt_out_link: ctx.optOutLink ?? "",
  };
}

/** From the approval request until sending starts, content and audience are frozen: changing them voids the approval. */
const APPROVAL_LOCKED: CampaignStatus[] = ["PENDING_APPROVAL", "APPROVED", "SCHEDULED"];

/**
 * Invalidates the campaign's approval (pending → CANCELLED, approved → SUPERSEDED, both audited and
 * notified) and returns it to DRAFT. Returns false when the campaign wasn't approval-locked.
 */
async function invalidateCampaignApproval(tx: Tx, ctx: ServiceContext, c: Pick<InvitationCampaign, "id" | "status" | "projectId" | "name">, reason: string) {
  if (!APPROVAL_LOCKED.includes(c.status)) return false;
  await cancelPendingApprovalsTx(tx, ctx, { entityType: "CAMPAIGN", entityId: c.id }, { reason, action: "approval.invalidated" });
  await supersedeApprovalsTx(tx, ctx, "CAMPAIGN", c.id, reason);
  const r = await tx.invitationCampaign.updateMany({ where: { id: c.id, status: c.status }, data: { status: "DRAFT", approvedById: null, approvedAt: null, version: { increment: 1 } } });
  if (!r.count) throw new ConflictError();
  await audit(tx, ctx, { action: "campaign.approval_invalidated", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: c.name, before: { status: c.status }, after: { status: "DRAFT" }, meta: { reason } });
  return true;
}

function projectActive(status: string) {
  return !(NO_CAMPAIGN_LAUNCH_STATUSES as readonly string[]).includes(status);
}

async function loadCampaign(tx: Tx, ctx: ServiceContext, campaignId: string, mode: "read" | "write" = "read") {
  const c = await tx.invitationCampaign.findUnique({ where: { id: campaignId } });
  if (!c || c.type !== "DIGITAL") throw new NotFoundError();
  const scope = await projectScope(tx, ctx, c.projectId);
  if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
  // LC rule 5: campaigns of archived projects are read-only (no edits, sends, cancels or check-ins)
  if (mode === "write") assertNotArchived(scope);
  return { c, scope };
}

export async function saveDigitalCampaign(ctx: ServiceContext, input: z.output<typeof digitalCampaignSchema>) {
  assertCan(ctx, "campaign.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    assertNotArchived(scope);
    if (!scope.operate) throw new ForbiddenError();
    if (input.channel === "EMAIL" && !input.subject) throw new ValidationError("errors.validation", { subject: ["common.required"] });
    const { id, projectId, version, ...data } = input;
    if (data.eventId && !(await tx.event.findFirst({ where: { id: data.eventId, projectId } }))) throw new NotFoundError();
    if (id) {
      const existing = await tx.invitationCampaign.findFirst({ where: { id, projectId, type: "DIGITAL" } });
      if (!existing) throw new NotFoundError();
      if (["SENDING", "ACTIVE", "COMPLETED", "CANCELLED"].includes(existing.status) && existing.bodyTemplate !== data.bodyTemplate) throw new ConflictError();
      // what the approver reviewed: any change from the request onwards voids the approval
      const contentChanged =
        existing.bodyTemplate !== data.bodyTemplate || existing.subject !== (data.subject ?? null) || existing.channel !== data.channel ||
        (existing.eventId ?? null) !== (data.eventId ?? null) || existing.rsvpEnabled !== data.rsvpEnabled || existing.qrEnabled !== data.qrEnabled ||
        // the send time is part of what was approved (a save that omits it keeps it)
        (data.scheduledAt !== undefined && (existing.scheduledAt?.getTime() ?? null) !== (data.scheduledAt ? new Date(data.scheduledAt as Date).getTime() : null));
      // the user's write is a compare-and-set on the version they loaded; voiding the approval after it
      // is a consequence of that write (it bumps the version again, as a system write)
      await casUpdate<InvitationCampaign>({ tx, ctx, model: "invitationCampaign", id, version, data: { ...data, subject: data.subject ?? null }, entityType: "CAMPAIGN" });
      const approvalInvalidated = contentChanged ? await invalidateCampaignApproval(tx, ctx, existing, "content changed after the approval request") : false;
      const c = await tx.invitationCampaign.findUniqueOrThrow({ where: { id } });
      if (existing.channel !== c.channel) await readdressAudience(tx, c);
      await audit(tx, ctx, { action: "campaign.update", entityType: "CAMPAIGN", entityId: id, projectId, summary: c.name, meta: { approvalInvalidated } });
      return Object.assign(c, { approvalInvalidated });
    }
    const ws = await tx.workstream.findFirst({ where: { projectId, kind: "DIGITAL_INVITES" } });
    const c = await tx.invitationCampaign.create({ data: { ...data, subject: data.subject ?? null, organizationId: ctx.orgId, projectId, workstreamId: ws?.id ?? null, type: "DIGITAL", createdById: ctx.userId } });
    await audit(tx, ctx, { action: "campaign.create", entityType: "CAMPAIGN", entityId: c.id, projectId, summary: c.name });
    return c;
  });
}

/** After a channel change, recomputes each unsent invitation's address and suppression state. */
async function readdressAudience(tx: Tx, c: { id: string; channel: Channel | null }) {
  if (!c.channel) return;
  const invs = await tx.digitalInvitation.findMany({ where: { campaignId: c.id, messages: { none: {} } } });
  const recipients = new Map((await tx.recipient.findMany({ where: { id: { in: invs.map((i) => i.recipientId) } } })).map((r) => [r.id, r]));
  const suppressed = new Set((await tx.suppressionEntry.findMany({ where: { channel: c.channel } })).map((s) => s.address));
  for (const inv of invs) {
    const r = recipients.get(inv.recipientId);
    const addr = (r && (c.channel === "EMAIL" ? r.email : r.mobile)) ?? "";
    await tx.digitalInvitation.update({ where: { id: inv.id }, data: { channel: c.channel, address: addr, status: !addr || suppressed.has(addr) ? "SUPPRESSED" : "QUEUED" } });
  }
}

/** Adds recipients to the audience. Addresses missing for the channel or on the suppression list are recorded as SUPPRESSED. */
export async function addAudience(ctx: ServiceContext, input: { campaignId: string; recipientIds: string[] }) {
  assertCan(ctx, "campaign.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c } = await loadCampaign(tx, ctx, input.campaignId, "write");
    if (["SENDING", "COMPLETED", "CANCELLED"].includes(c.status)) throw new ValidationError("errors.importState");
    const approvalInvalidated = await invalidateCampaignApproval(tx, ctx, c, "audience changed after the approval request");
    const recipients = await tx.recipient.findMany({ where: { id: { in: input.recipientIds }, projectId: c.projectId, deletedAt: null, anonymizedAt: null } });
    const existing = new Set((await tx.digitalInvitation.findMany({ where: { campaignId: c.id }, select: { recipientId: true } })).map((x) => x.recipientId));
    const address = (r: Recipient) => (c.channel === "EMAIL" ? r.email : r.mobile);
    const suppressed = new Set((await tx.suppressionEntry.findMany({ where: { channel: c.channel!, address: { in: recipients.map(address).filter((x): x is string => !!x) } } })).map((s) => s.address));
    let added = 0;
    let missing = 0;
    for (const r of recipients) {
      if (existing.has(r.id)) continue;
      const addr = address(r);
      if (!addr) missing++;
      await tx.digitalInvitation.create({
        data: { organizationId: ctx.orgId, projectId: c.projectId, campaignId: c.id, recipientId: r.id, channel: c.channel!, address: addr ?? "", status: !addr || suppressed.has(addr) ? "SUPPRESSED" : "QUEUED", qrCode: c.qrEnabled ? `QR-${shortCode(10)}` : null },
      });
      added++;
    }
    await audit(tx, ctx, { action: "campaign.audience_add", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: `${added} added, ${missing} without address` });
    return { added, missing, skipped: existing.size, approvalInvalidated };
  });
}

export async function removeAudience(ctx: ServiceContext, input: { campaignId: string; invitationIds: string[] }) {
  assertCan(ctx, "campaign.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c } = await loadCampaign(tx, ctx, input.campaignId, "write");
    if (["SENDING", "COMPLETED", "CANCELLED"].includes(c.status)) throw new ValidationError("errors.importState");
    const approvalInvalidated = await invalidateCampaignApproval(tx, ctx, c, "audience changed after the approval request");
    const r = await tx.digitalInvitation.deleteMany({ where: { id: { in: input.invitationIds }, campaignId: c.id, status: { in: ["QUEUED", "SUPPRESSED"] }, messages: { none: {} } } });
    await audit(tx, ctx, { action: "campaign.audience_remove", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: `${r.count} removed` });
    return { removed: r.count, approvalInvalidated };
  });
}

export async function requestCampaignApproval(ctx: ServiceContext, campaignId: string, version?: number) {
  assertCan(ctx, "campaign.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c } = await loadCampaign(tx, ctx, campaignId, "write");
    await assertVersion(tx, { model: "invitationCampaign", id: c.id, version, stored: c.version, entityType: "CAMPAIGN", data: { status: "PENDING_APPROVAL" } });
    if (c.status !== "DRAFT") throw new ValidationError("errors.importState");
    const audience = await tx.digitalInvitation.count({ where: { campaignId, status: "QUEUED" } });
    if (!audience) throw new ValidationError("errors.noRowsSelected");
    // DRAFT → PENDING_APPROVAL is a transition of a protected record: claim the loaded version first
    // (the row stays locked until commit, so a second request waits and then conflicts)
    await casUpdate<InvitationCampaign>({ tx, ctx, model: "invitationCampaign", id: c.id, version, data: {}, entityType: "CAMPAIGN" });
    const a = await requestApprovalTx(tx, ctx, { projectId: c.projectId, entityType: "CAMPAIGN", entityId: c.id, title: `${c.name} (${audience})`, description: c.bodyTemplate?.slice(0, 500) ?? null, approverType: "INTERNAL", approverUserId: null });
    await emit(tx, ctx, "campaign.approval_requested", { projectId: c.projectId, title: c.name, link: `/projects/${c.projectId}/digital/${c.id}` });
    return a;
  });
}

/** Sends (or schedules) an APPROVED campaign. Never sends unapproved bulk outbound messages. */
export async function launchCampaign(ctx: ServiceContext, campaignId: string, version?: number) {
  assertCan(ctx, "campaign.send");
  const c = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c, scope } = await loadCampaign(tx, ctx, campaignId, "write");
    await assertVersion(tx, { model: "invitationCampaign", id: c.id, version, stored: c.version, entityType: "CAMPAIGN", data: { status: "SENDING" } });
    if (!projectActive(scope.project.status)) throw new ValidationError("errors.projectNotSending");
    if (c.status !== "APPROVED") throw new ValidationError("errors.campaignNotApproved");
    const approval = await tx.approval.findFirst({ where: { entityType: "CAMPAIGN", entityId: c.id, status: "APPROVED" }, orderBy: { decidedAt: "desc" } });
    if (!approval) throw new ValidationError("errors.campaignNotApproved");
    const next = c.scheduledAt && c.scheduledAt > new Date() ? "SCHEDULED" : "SENDING";
    await casUpdate<InvitationCampaign>({ tx, ctx, model: "invitationCampaign", id: c.id, version, data: { status: next }, entityType: "CAMPAIGN" });
    await audit(tx, ctx, { action: next === "SCHEDULED" ? "campaign.schedule" : "campaign.launch", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: c.name, meta: { scheduledAt: c.scheduledAt, approvalId: approval.id } });
    return { ...c, status: next };
  });
  // Inline mode can't hold a delayed job: a scheduled campaign waits for the scheduler step
  // (dispatchDueCampaigns), which sends it once it is due. Queue mode also gets a delayed job.
  if (c.status === "SCHEDULED" && jobsMode() === "inline") return { status: c.status, mode: "scheduled" as const };
  const delay = c.status === "SCHEDULED" && c.scheduledAt ? c.scheduledAt.getTime() - Date.now() : 0;
  const mode = await enqueue("campaign.dispatch", { orgId: ctx.orgId, actorId: ctx.userId, campaignId }, { jobId: `campaign-${campaignId}`, delay: Math.max(0, delay) });
  return { status: c.status, mode };
}

export async function cancelCampaign(ctx: ServiceContext, campaignId: string, version?: number) {
  assertCan(ctx, "campaign.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c } = await loadCampaign(tx, ctx, campaignId, "write");
    await assertVersion(tx, { model: "invitationCampaign", id: c.id, version, stored: c.version, entityType: "CAMPAIGN", data: { status: "CANCELLED" } });
    if (["COMPLETED", "CANCELLED"].includes(c.status)) throw new ValidationError("errors.invalidTransition");
    await casUpdate<InvitationCampaign>({ tx, ctx, model: "invitationCampaign", id: c.id, version, data: { status: "CANCELLED" }, entityType: "CAMPAIGN" });
    await cancelPendingApprovalsTx(tx, ctx, { entityType: "CAMPAIGN", entityId: c.id }, { reason: "campaign cancelled" });
    const r = await tx.messageJob.updateMany({ where: { invitation: { campaignId: c.id }, status: "QUEUED" }, data: { status: "CANCELLED" } });
    await audit(tx, ctx, { action: "campaign.cancel", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: `${r.count} queued messages cancelled`, before: { status: c.status }, after: { status: "CANCELLED" } });
  });
}

// ── Stalled sends: manual actions (BUSINESS_RULES §7.2) ─────────────────────

/** "Resume sending" for a SENDING campaign whose dispatch stopped (also after the automatic attempts ran out). */
export async function resumeCampaignSend(ctx: ServiceContext, campaignId: string) {
  assertCan(ctx, "campaign.send");
  const ok = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c, scope } = await loadCampaign(tx, ctx, campaignId, "write");
    if (c.status !== "SENDING") throw new ValidationError("errors.invalidTransition");
    const state = campaignSendState(c, scope.project.status);
    if (!state.paused && !state.stalled) return false; // a live dispatch holds it: nothing to do
    await audit(tx, ctx, { action: "campaign.resume", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: c.name, meta: { attempts: c.dispatchAttempts } });
    return true;
  });
  if (!ok) return { resumed: false };
  const { dispatchCampaign } = await import("./sender");
  const r = await dispatchCampaign(ctx.orgId, ctx.userId, campaignId);
  return { resumed: r.claimed };
}

/**
 * "Cancel remaining sends": queued messages and invitations not yet sent become CANCELLED; what was
 * sent stays sent and the campaign goes on (ACTIVE), or is CANCELLED when nothing went out.
 */
export async function cancelRemainingSends(ctx: ServiceContext, campaignId: string, version?: number) {
  assertCan(ctx, "campaign.send");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c } = await loadCampaign(tx, ctx, campaignId, "write");
    await assertVersion(tx, { model: "invitationCampaign", id: c.id, version, stored: c.version, entityType: "CAMPAIGN", data: { status: "ACTIVE" } });
    if (c.status !== "SENDING") throw new ValidationError("errors.invalidTransition");
    const jobs = await tx.messageJob.findMany({ where: { invitation: { campaignId: c.id }, status: "QUEUED" }, select: { id: true, invitationId: true } });
    await tx.messageJob.updateMany({ where: { id: { in: jobs.map((j) => j.id) }, status: "QUEUED" }, data: { status: "CANCELLED" } });
    const invIds = jobs.map((j) => j.invitationId).filter((x): x is string => !!x);
    await tx.digitalInvitation.updateMany({ where: { OR: [{ id: { in: invIds } }, { campaignId: c.id, status: "QUEUED", messages: { none: {} } }] }, data: { status: "CANCELLED" } });
    const sent = await tx.messageJob.count({ where: { invitation: { campaignId: c.id }, status: { in: ["SENDING", "SENT", "DELIVERED", "READ", "FAILED"] } } });
    const next = sent ? "ACTIVE" : "CANCELLED";
    await casUpdate<InvitationCampaign>({ tx, ctx, model: "invitationCampaign", id: c.id, version, data: { status: next, dispatchLeaseUntil: null }, entityType: "CAMPAIGN" });
    await audit(tx, ctx, { action: "campaign.cancel_remaining", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: `${jobs.length} queued messages cancelled`, before: { status: c.status }, after: { status: next } });
    return { cancelled: jobs.length, status: next };
  });
}

/** Manual review of a message whose outcome is unknown (§7.2 rule 3): re-send that one message. */
export async function resendMessage(ctx: ServiceContext, input: { campaignId: string; invitationId: string }) {
  assertCan(ctx, "campaign.send");
  const jobId = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c } = await loadCampaign(tx, ctx, input.campaignId, "write");
    const job = await tx.messageJob.findFirst({ where: { invitationId: input.invitationId, invitation: { campaignId: c.id }, status: "FAILED", lastError: "outcome_unknown" } });
    if (!job) throw new NotFoundError();
    await tx.messageJob.updateMany({ where: { id: job.id, status: "FAILED" }, data: { status: "QUEUED", lastError: null, maxAttempts: job.attempts + 1 } });
    await tx.digitalInvitation.update({ where: { id: input.invitationId }, data: { status: "QUEUED" } });
    await audit(tx, ctx, { action: "message.resend", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: job.id, meta: { reason: "outcome_unknown" } });
    return job.id;
  });
  await enqueue("message.send", { orgId: ctx.orgId, messageJobId: jobId }, { jobId: `msg-${jobId}-resend-${Date.now()}`, attempts: 1 });
  return { resent: true };
}

// ── Queries ─────────────────────────────────────────────────────────────────

export async function listDigitalCampaigns(ctx: ServiceContext, projectId?: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const projects = projectId ? [(await projectScope(tx, ctx, projectId)).project] : await tx.project.findMany({ where: projectVisibilityWhere(ctx) });
    const ids = projects.map((p) => p.id);
    const campaigns = await tx.invitationCampaign.findMany({ where: { projectId: { in: ids }, type: "DIGITAL" }, orderBy: { createdAt: "desc" } });
    const stats = await tx.digitalInvitation.groupBy({ by: ["campaignId", "status"], where: { campaignId: { in: campaigns.map((c) => c.id) } }, _count: true });
    const rsvp = await tx.digitalInvitation.groupBy({ by: ["campaignId", "rsvpStatus"], where: { campaignId: { in: campaigns.map((c) => c.id) } }, _count: true });
    return campaigns.map((c) => {
      const s = stats.filter((x) => x.campaignId === c.id);
      const r = rsvp.filter((x) => x.campaignId === c.id);
      const total = s.reduce((n, x) => n + x._count, 0);
      const sent = s.filter((x) => ["SENT", "DELIVERED", "READ"].includes(x.status)).reduce((n, x) => n + x._count, 0);
      return { ...c, project: projects.find((p) => p.id === c.projectId)!, total, sent, attending: r.find((x) => x.rsvpStatus === "ATTENDING")?._count ?? 0, responded: r.filter((x) => x.rsvpStatus).reduce((n, x) => n + x._count, 0) };
    });
  });
}

export async function getDigitalCampaign(ctx: ServiceContext, campaignId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c, scope } = await loadCampaign(tx, ctx, campaignId);
    const [invitations, byStatus, byRsvp, approvals, provider, event, simulated] = await Promise.all([
      tx.digitalInvitation.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" }, take: 3000, include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } } }),
      tx.digitalInvitation.groupBy({ by: ["status"], where: { campaignId }, _count: true }),
      tx.digitalInvitation.groupBy({ by: ["rsvpStatus"], where: { campaignId }, _count: true }),
      tx.approval.findMany({ where: { entityType: "CAMPAIGN", entityId: campaignId }, include: { decisions: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "desc" } }),
      tx.providerConfig.findUnique({ where: { organizationId_channel: { organizationId: ctx.orgId, channel: c.channel ?? "EMAIL" } } }),
      c.eventId ? tx.event.findUnique({ where: { id: c.eventId } }) : tx.event.findFirst({ where: { projectId: c.projectId }, orderBy: { startsAt: "asc" } }),
      tx.messageJob.count({ where: { invitation: { campaignId }, simulated: true } }),
    ]);
    const recipients = await tx.recipient.findMany({ where: { id: { in: invitations.map((i) => i.recipientId) } } });
    const rmap = new Map(recipients.map((r) => [r.id, r]));
    const available = await tx.recipient.findMany({ where: { projectId: c.projectId, deletedAt: null, anonymizedAt: null, id: { notIn: invitations.map((i) => i.recipientId) } }, select: { id: true, code: true, nameAr: true, nameEn: true, organizationName: true, email: true, mobile: true, vipTier: true }, take: 3000 });
    const sample = recipients[0] ?? null;
    const preview = sample ? renderTemplate(c.bodyTemplate ?? "", personalization(sample, { locale: ctx.locale, eventName: event?.name, eventDate: event?.startsAt, rsvpLink: `${appUrl()}/rsvp/…`, optOutLink: `${appUrl()}/rsvp/…?optout=1` })) : null;
    const live = providerStatus()[c.channel ?? "EMAIL"];
    const mask = (v: string) => (scope.vip ? v : v.includes("@") ? v.replace(/^(.).*(@.*)$/, "$1•••$2") : `•••${v.slice(-4)}`);
    return {
      campaign: c,
      /** stalled / paused / late send (BUSINESS_RULES §7.2, UX note 8) */
      send: campaignSendState(c, scope.project.status),
      scope: { vip: scope.vip, manage: can(ctx, "campaign.manage") && !scope.archived, approve: can(ctx, "campaign.approve"), send: can(ctx, "campaign.send") && !scope.archived, export: scope.export },
      providerMode: provider?.mode === "LIVE" && live ? "LIVE" : "SIMULATION",
      simulatedMessages: simulated,
      event: event ? { id: event.id, name: event.name, startsAt: event.startsAt } : null,
      preview,
      counts: Object.fromEntries(byStatus.map((s) => [s.status, s._count])) as Record<string, number>,
      rsvp: Object.fromEntries(byRsvp.map((s) => [s.rsvpStatus ?? "NONE", s._count])) as Record<string, number>,
      approvals,
      invitations: invitations.map((i) => {
        const r = rmap.get(i.recipientId);
        return { id: i.id, status: i.status, rsvpStatus: i.rsvpStatus, respondedAt: i.respondedAt, checkedInAt: i.checkedInAt, address: i.address ? mask(i.address) : "", qrCode: i.qrCode, name: r ? (ctx.locale === "en" ? r.nameEn ?? r.nameAr : r.nameAr ?? r.nameEn) : "—", code: r?.code ?? "", organization: r?.organizationName ?? null, lastError: i.messages[0]?.lastError ?? null, simulated: i.messages[0]?.simulated ?? null };
      }),
      available: available.map((r) => ({ id: r.id, code: r.code, name: (ctx.locale === "en" ? r.nameEn ?? r.nameAr : r.nameAr ?? r.nameEn) ?? r.code, organization: r.organizationName, vipTier: r.vipTier, hasAddress: !!(c.channel === "EMAIL" ? r.email : r.mobile) })),
    };
  });
}

// ── RSVP (public) ───────────────────────────────────────────────────────────

/** Issues (or re-issues) an RSVP token for an invitation. Only the hash is stored. */
export async function issueRsvpToken(tx: Tx, orgId: string, inv: DigitalInvitation, expiresAt: Date | null) {
  const token = randomToken(24);
  const id = sha256Hex(token);
  await tx.digitalInvitation.update({ where: { id: inv.id }, data: { rsvpTokenHash: id } });
  await db.publicToken.upsert({ where: { id }, create: { id, kind: "RSVP", organizationId: orgId, refId: inv.id, expiresAt }, update: {} });
  return token;
}

/** RSVP links stay usable until a week after the later of the RSVP deadline and the event end (90 days if neither is set). */
export function rsvpTokenExpiry(rsvpDeadline: Date | null, eventEndsAt: Date | null, now = new Date()): Date {
  const base = Math.max(rsvpDeadline?.getTime() ?? 0, eventEndsAt?.getTime() ?? 0) || now.getTime() + 83 * 86400_000;
  return new Date(base + 7 * 86400_000);
}

async function resolveRsvp(token: string, opts: { allowExpired?: boolean } = {}) {
  if (!token || token.length > 100) return null;
  const pt = await db.publicToken.findUnique({ where: { id: sha256Hex(token) } });
  if (!pt || pt.kind !== "RSVP" || pt.usedAt) return null;
  // an expired link no longer reveals the guest's name or accepts a response
  if (!opts.allowExpired && pt.expiresAt && pt.expiresAt < new Date()) return null;
  return pt;
}

/** Public, unauthenticated: minimal data only (honorific + name, event name/date, org branding). */
export async function getRsvpPage(token: string) {
  const pt = await resolveRsvp(token);
  if (!pt) return null;
  return withTenant({ orgId: pt.organizationId }, async (tx) => {
    const inv = await tx.digitalInvitation.findUnique({ where: { id: pt.refId } });
    if (!inv) return null;
    const [r, c, org] = await Promise.all([
      tx.recipient.findUnique({ where: { id: inv.recipientId }, select: { nameAr: true, nameEn: true, honorific: true } }),
      tx.invitationCampaign.findUniqueOrThrow({ where: { id: inv.campaignId } }),
      tx.organization.findUniqueOrThrow({ where: { id: pt.organizationId }, select: { name: true, nameEn: true, brandColor: true } }),
    ]);
    // §1.3: the invitation of a cancelled project (or a cancelled campaign) is no longer active. The page
    // says only that: no event details, no entry code, no responses
    if (await invitationInactive(tx, c)) {
      return { org, recipient: r, campaign: { name: null, qrEnabled: false, rsvpEnabled: false, deadline: null }, event: null, rsvpStatus: null, qrCode: null, closed: true, inactive: true, suppressed: inv.status === "SUPPRESSED" };
    }
    const event = c.eventId ? await tx.event.findUnique({ where: { id: c.eventId } }) : await tx.event.findFirst({ where: { projectId: c.projectId }, orderBy: { startsAt: "asc" } });
    const venue = event?.venueId ? await tx.venue.findUnique({ where: { id: event.venueId }, select: { name: true, city: true } }) : null;
    const closed = !!(c.rsvpDeadline && c.rsvpDeadline < new Date()) || c.status === "CANCELLED";
    return { org, recipient: r, campaign: { name: c.name as string | null, qrEnabled: c.qrEnabled, rsvpEnabled: c.rsvpEnabled, deadline: c.rsvpDeadline }, event: event ? { name: event.name, startsAt: event.startsAt, venue } : null, rsvpStatus: inv.rsvpStatus, qrCode: inv.rsvpStatus === "ATTENDING" ? inv.qrCode : null, closed, inactive: false, suppressed: inv.status === "SUPPRESSED" };
  });
}

/** A cancelled campaign, or any campaign of a cancelled project, takes no more responses or check-ins. */
async function invitationInactive(tx: Tx, c: Pick<InvitationCampaign, "status" | "projectId">) {
  if (c.status === "CANCELLED") return true;
  const p = await tx.project.findUnique({ where: { id: c.projectId }, select: { status: true } });
  return !p || p.status === "CANCELLED";
}

export const rsvpSchema = z.object({ token: z.string().min(10).max(100), response: z.enum(["ATTENDING", "DECLINED", "MAYBE"]), guestsCount: z.coerce.number().int().min(1).max(10).default(1), note: z.string().trim().max(500).nullish() });

export async function submitRsvp(input: z.output<typeof rsvpSchema>, ip: string | null) {
  await enforceRateLimit(`rsvp:${ip ?? "unknown"}`, 30, 600);
  const pt = await resolveRsvp(input.token);
  if (!pt) throw new NotFoundError("errors.tokenInvalid");
  return withTenant({ orgId: pt.organizationId }, async (tx) => {
    const inv = await tx.digitalInvitation.findUnique({ where: { id: pt.refId } });
    if (!inv) throw new NotFoundError("errors.tokenInvalid");
    const c = await tx.invitationCampaign.findUniqueOrThrow({ where: { id: inv.campaignId } });
    if (!c.rsvpEnabled || (await invitationInactive(tx, c)) || (c.rsvpDeadline && c.rsvpDeadline < new Date())) throw new ValidationError("errors.tokenInvalid");
    await tx.rSVP.create({ data: { organizationId: pt.organizationId, invitationId: inv.id, response: input.response, guestsCount: input.guestsCount, note: input.note ?? null, ip } });
    await tx.digitalInvitation.update({ where: { id: inv.id }, data: { rsvpStatus: input.response, respondedAt: new Date(), qrCode: input.response === "ATTENDING" && c.qrEnabled && !inv.qrCode ? `QR-${shortCode(10)}` : inv.qrCode } });
    await tx.auditEvent.create({ data: { organizationId: pt.organizationId, actorName: "RSVP", action: "rsvp.submit", entityType: "DIGITAL_INVITATION", entityId: inv.id, projectId: inv.projectId, summary: input.response, ip } });
    return { response: input.response };
  });
}

/** Opt-out → suppression list (honoured by every future send on that channel). */
export async function optOut(token: string, ip: string | null) {
  await enforceRateLimit(`optout:${ip ?? "unknown"}`, 30, 600);
  // opting out stays possible on an expired link: it only ever reduces what we send
  const pt = await resolveRsvp(token, { allowExpired: true });
  if (!pt) throw new NotFoundError("errors.tokenInvalid");
  return withTenant({ orgId: pt.organizationId }, async (tx) => {
    const inv = await tx.digitalInvitation.findUnique({ where: { id: pt.refId } });
    if (!inv) throw new NotFoundError();
    if (inv.address) {
      await tx.suppressionEntry.upsert({ where: { organizationId_channel_address: { organizationId: pt.organizationId, channel: inv.channel, address: inv.address } }, create: { organizationId: pt.organizationId, channel: inv.channel, address: inv.address, reason: "OPT_OUT" }, update: {} });
    }
    await tx.digitalInvitation.update({ where: { id: inv.id }, data: { status: "SUPPRESSED" } });
    await tx.auditEvent.create({ data: { organizationId: pt.organizationId, actorName: "RSVP", action: "suppression.opt_out", entityType: "DIGITAL_INVITATION", entityId: inv.id, projectId: inv.projectId, ip } });
  });
}

// ── Check-in ────────────────────────────────────────────────────────────────

export async function checkIn(ctx: ServiceContext, input: { campaignId: string; code: string }) {
  if (!can(ctx, "event.manage") && !can(ctx, "campaign.manage")) throw new ForbiddenError();
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c } = await loadCampaign(tx, ctx, input.campaignId, "write");
    const inv = await tx.digitalInvitation.findFirst({ where: { campaignId: c.id, qrCode: input.code.trim().toUpperCase() } });
    if (!inv) throw new NotFoundError();
    const r = await tx.recipient.findUnique({ where: { id: inv.recipientId }, select: { nameAr: true, nameEn: true, honorific: true, vipTier: true } });
    if (inv.checkedInAt) return { already: true, checkedInAt: inv.checkedInAt, rsvp: inv.rsvpStatus, recipient: r };
    const at = new Date();
    await tx.digitalInvitation.update({ where: { id: inv.id }, data: { checkedInAt: at } });
    const guest = await tx.guest.findFirst({ where: { recipientId: inv.recipientId, projectId: c.projectId } });
    if (guest) await tx.guest.update({ where: { id: guest.id }, data: { attendance: "ARRIVED", version: { increment: 1 } } });
    await audit(tx, ctx, { action: "checkin.scan", entityType: "DIGITAL_INVITATION", entityId: inv.id, projectId: c.projectId });
    return { already: false, checkedInAt: at, rsvp: inv.rsvpStatus, recipient: r };
  });
}

// ── Providers & suppression ─────────────────────────────────────────────────

export async function listProviders(ctx: ServiceContext) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const rows = await tx.providerConfig.findMany();
    const status = providerStatus();
    const suppressions = await tx.suppressionEntry.count();
    return { rows: rows.map((r) => ({ ...r, credentialsPresent: !!status[r.channel], liveProvider: status[r.channel] })), suppressions };
  });
}

export async function setProviderMode(ctx: ServiceContext, input: { channel: Channel; mode: "SIMULATION" | "LIVE"; senderId?: string | null }) {
  assertCan(ctx, "org.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    if (input.mode === "LIVE" && !providerStatus()[input.channel]) throw new ValidationError("errors.providerNotConfigured");
    const r = await tx.providerConfig.upsert({
      where: { organizationId_channel: { organizationId: ctx.orgId, channel: input.channel } },
      create: { organizationId: ctx.orgId, channel: input.channel, provider: input.mode === "LIVE" ? providerStatus()[input.channel]! : "simulation", mode: input.mode, senderId: input.senderId ?? null },
      update: { mode: input.mode, provider: input.mode === "LIVE" ? providerStatus()[input.channel]! : "simulation", senderId: input.senderId ?? null },
    });
    await audit(tx, ctx, { action: "provider.mode", entityType: "PROVIDER", entityId: r.id, summary: `${input.channel} → ${input.mode}` });
    return r;
  });
}

export async function guestListRows(ctx: ServiceContext, campaignId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c, scope } = await loadCampaign(tx, ctx, campaignId);
    if (!scope.export || !can(ctx, "export.data")) throw new ForbiddenError();
    const inv = await tx.digitalInvitation.findMany({ where: { campaignId }, include: { rsvps: { orderBy: { createdAt: "desc" }, take: 1 } } });
    const recipients = await tx.recipient.findMany({ where: { id: { in: inv.map((i) => i.recipientId) } } });
    await audit(tx, ctx, { action: "export.guest_list", entityType: "CAMPAIGN", entityId: campaignId, projectId: c.projectId, summary: `${inv.length} rows` });
    return { campaign: c, rows: inv.map((i) => ({ inv: i, r: recipients.find((x) => x.id === i.recipientId)! })), vip: scope.vip };
  });
}

