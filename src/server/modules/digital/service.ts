import { z } from "zod";
import type { Channel, DigitalInvitation, Recipient } from "@/generated/prisma/client";
import { formatDateTime } from "@/lib/format";
import { shortCode } from "@/lib/id";
import { randomToken, sha256Hex } from "@/server/auth/crypto";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan, can, projectScope, projectVisibilityWhere } from "@/server/authz/policy";
import { db } from "@/server/db/client";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { emit } from "@/server/modules/automation/outbox";
import { requestApprovalTx } from "@/server/modules/approvals/service";
import { enqueue } from "@/server/jobs/dispatch";
import { providerStatus } from "./providers";

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
});

function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
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

async function loadCampaign(tx: Tx, ctx: ServiceContext, campaignId: string) {
  const c = await tx.invitationCampaign.findUnique({ where: { id: campaignId } });
  if (!c || c.type !== "DIGITAL") throw new NotFoundError();
  const scope = await projectScope(tx, ctx, c.projectId);
  if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
  return { c, scope };
}

export async function saveDigitalCampaign(ctx: ServiceContext, input: z.output<typeof digitalCampaignSchema>) {
  assertCan(ctx, "campaign.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.operate) throw new ForbiddenError();
    if (input.channel === "EMAIL" && !input.subject) throw new ValidationError("errors.validation", { subject: ["common.required"] });
    const { id, projectId, ...data } = input;
    if (id) {
      const existing = await tx.invitationCampaign.findFirst({ where: { id, projectId, type: "DIGITAL" } });
      if (!existing) throw new NotFoundError();
      // content changes after approval require a fresh approval
      if (["APPROVED", "SCHEDULED"].includes(existing.status) && (existing.bodyTemplate !== data.bodyTemplate || existing.subject !== (data.subject ?? null) || existing.channel !== data.channel)) {
        await tx.approval.updateMany({ where: { entityType: "CAMPAIGN", entityId: id, status: "APPROVED" }, data: { status: "CANCELLED" } });
        await tx.invitationCampaign.update({ where: { id }, data: { status: "DRAFT", approvedById: null, approvedAt: null } });
      }
      if (["SENDING", "ACTIVE", "COMPLETED"].includes(existing.status) && existing.bodyTemplate !== data.bodyTemplate) throw new ConflictError();
      const c = await tx.invitationCampaign.update({ where: { id }, data: { ...data, subject: data.subject ?? null } });
      if (existing.channel !== c.channel) await readdressAudience(tx, c);
      await audit(tx, ctx, { action: "campaign.update", entityType: "CAMPAIGN", entityId: id, projectId, summary: c.name });
      return c;
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
    const { c } = await loadCampaign(tx, ctx, input.campaignId);
    if (["SENDING", "COMPLETED", "CANCELLED"].includes(c.status)) throw new ValidationError("errors.importState");
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
    return { added, missing, skipped: existing.size };
  });
}

export async function removeAudience(ctx: ServiceContext, input: { campaignId: string; invitationIds: string[] }) {
  assertCan(ctx, "campaign.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c } = await loadCampaign(tx, ctx, input.campaignId);
    const r = await tx.digitalInvitation.deleteMany({ where: { id: { in: input.invitationIds }, campaignId: c.id, status: { in: ["QUEUED", "SUPPRESSED"] }, messages: { none: {} } } });
    await audit(tx, ctx, { action: "campaign.audience_remove", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: `${r.count} removed` });
    return { removed: r.count };
  });
}

export async function requestCampaignApproval(ctx: ServiceContext, campaignId: string) {
  assertCan(ctx, "campaign.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c } = await loadCampaign(tx, ctx, campaignId);
    if (c.status !== "DRAFT") throw new ValidationError("errors.importState");
    const audience = await tx.digitalInvitation.count({ where: { campaignId, status: "QUEUED" } });
    if (!audience) throw new ValidationError("errors.noRowsSelected");
    const a = await requestApprovalTx(tx, ctx, { projectId: c.projectId, entityType: "CAMPAIGN", entityId: c.id, title: `${c.name} (${audience})`, description: c.bodyTemplate?.slice(0, 500) ?? null, approverType: "INTERNAL", approverUserId: null });
    await emit(tx, ctx, "campaign.approval_requested", { projectId: c.projectId, title: c.name, link: `/projects/${c.projectId}/digital/${c.id}` });
    return a;
  });
}

/** Sends (or schedules) an APPROVED campaign. Never sends unapproved bulk outbound messages. */
export async function launchCampaign(ctx: ServiceContext, campaignId: string) {
  assertCan(ctx, "campaign.send");
  const c = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c } = await loadCampaign(tx, ctx, campaignId);
    if (c.status !== "APPROVED") throw new ValidationError("errors.campaignNotApproved");
    const approval = await tx.approval.findFirst({ where: { entityType: "CAMPAIGN", entityId: c.id, status: "APPROVED" }, orderBy: { decidedAt: "desc" } });
    if (!approval) throw new ValidationError("errors.campaignNotApproved");
    const next = c.scheduledAt && c.scheduledAt > new Date() ? "SCHEDULED" : "SENDING";
    const r = await tx.invitationCampaign.updateMany({ where: { id: c.id, status: "APPROVED" }, data: { status: next } });
    if (!r.count) throw new ConflictError();
    await audit(tx, ctx, { action: next === "SCHEDULED" ? "campaign.schedule" : "campaign.launch", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: c.name, meta: { scheduledAt: c.scheduledAt, approvalId: approval.id } });
    return { ...c, status: next };
  });
  const delay = c.status === "SCHEDULED" && c.scheduledAt ? c.scheduledAt.getTime() - Date.now() : 0;
  const mode = await enqueue("campaign.dispatch", { orgId: ctx.orgId, actorId: ctx.userId, campaignId }, { jobId: `campaign-${campaignId}`, delay: Math.max(0, delay) });
  return { status: c.status, mode };
}

export async function cancelCampaign(ctx: ServiceContext, campaignId: string) {
  assertCan(ctx, "campaign.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { c } = await loadCampaign(tx, ctx, campaignId);
    await tx.invitationCampaign.update({ where: { id: c.id }, data: { status: "CANCELLED" } });
    const r = await tx.messageJob.updateMany({ where: { invitation: { campaignId: c.id }, status: "QUEUED" }, data: { status: "CANCELLED" } });
    await audit(tx, ctx, { action: "campaign.cancel", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: `${r.count} queued messages cancelled` });
  });
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
      scope: { vip: scope.vip, manage: can(ctx, "campaign.manage"), approve: can(ctx, "campaign.approve"), send: can(ctx, "campaign.send"), export: scope.export },
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

async function resolveRsvp(token: string) {
  if (!token || token.length > 100) return null;
  const pt = await db.publicToken.findUnique({ where: { id: sha256Hex(token) } });
  if (!pt || pt.kind !== "RSVP") return null;
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
    const event = c.eventId ? await tx.event.findUnique({ where: { id: c.eventId } }) : await tx.event.findFirst({ where: { projectId: c.projectId }, orderBy: { startsAt: "asc" } });
    const venue = event?.venueId ? await tx.venue.findUnique({ where: { id: event.venueId }, select: { name: true, city: true } }) : null;
    const closed = !!(c.rsvpDeadline && c.rsvpDeadline < new Date()) || c.status === "CANCELLED";
    return { org, recipient: r, campaign: { name: c.name, qrEnabled: c.qrEnabled, rsvpEnabled: c.rsvpEnabled, deadline: c.rsvpDeadline }, event: event ? { name: event.name, startsAt: event.startsAt, venue } : null, rsvpStatus: inv.rsvpStatus, qrCode: inv.rsvpStatus === "ATTENDING" ? inv.qrCode : null, closed, suppressed: inv.status === "SUPPRESSED" };
  });
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
    if (!c.rsvpEnabled || c.status === "CANCELLED" || (c.rsvpDeadline && c.rsvpDeadline < new Date())) throw new ValidationError("errors.tokenInvalid");
    await tx.rSVP.create({ data: { organizationId: pt.organizationId, invitationId: inv.id, response: input.response, guestsCount: input.guestsCount, note: input.note ?? null, ip } });
    await tx.digitalInvitation.update({ where: { id: inv.id }, data: { rsvpStatus: input.response, respondedAt: new Date(), qrCode: input.response === "ATTENDING" && c.qrEnabled && !inv.qrCode ? `QR-${shortCode(10)}` : inv.qrCode } });
    await tx.auditEvent.create({ data: { organizationId: pt.organizationId, actorName: "RSVP", action: "rsvp.submit", entityType: "DIGITAL_INVITATION", entityId: inv.id, projectId: inv.projectId, summary: input.response, ip } });
    return { response: input.response };
  });
}

/** Opt-out → suppression list (honoured by every future send on that channel). */
export async function optOut(token: string, ip: string | null) {
  await enforceRateLimit(`optout:${ip ?? "unknown"}`, 30, 600);
  const pt = await resolveRsvp(token);
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
    const { c } = await loadCampaign(tx, ctx, input.campaignId);
    const inv = await tx.digitalInvitation.findFirst({ where: { campaignId: c.id, qrCode: input.code.trim().toUpperCase() } });
    if (!inv) throw new NotFoundError();
    const r = await tx.recipient.findUnique({ where: { id: inv.recipientId }, select: { nameAr: true, nameEn: true, honorific: true, vipTier: true } });
    if (inv.checkedInAt) return { already: true, checkedInAt: inv.checkedInAt, rsvp: inv.rsvpStatus, recipient: r };
    const at = new Date();
    await tx.digitalInvitation.update({ where: { id: inv.id }, data: { checkedInAt: at } });
    const guest = await tx.guest.findFirst({ where: { recipientId: inv.recipientId, projectId: c.projectId } });
    if (guest) await tx.guest.update({ where: { id: guest.id }, data: { attendance: "ARRIVED" } });
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

