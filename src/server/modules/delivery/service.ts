import { z } from "zod";
import type { DeliveryStatus, Prisma, Recipient } from "@/generated/prisma/client";
import { createId, shortCode } from "@/lib/id";
import { maskPhone } from "@/lib/phone";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan, can, projectScope, type ProjectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { emit } from "@/server/modules/automation/outbox";
import { ACTIVE_FIELD_STATUSES, ASSIGNABLE, ATTEMPT_OUTCOMES, canTransition, FAILURE_REASONS } from "./state-machine";

export interface CampaignConfig {
  requireEvidence: boolean;
  requireReceiverName: boolean;
  maxAttempts: number;
}

export function campaignConfig(raw: unknown): CampaignConfig {
  const c = (raw ?? {}) as Partial<CampaignConfig>;
  return { requireEvidence: c.requireEvidence ?? true, requireReceiverName: c.requireReceiverName ?? true, maxAttempts: c.maxAttempts ?? 3 };
}

// ── Masking (least privilege) ───────────────────────────────────────────────

export type MaskedRecipient = Pick<Recipient, "id" | "code" | "nameAr" | "nameEn" | "honorific" | "jobTitle" | "organizationName" | "vipTier" | "category" | "city" | "district" | "priority" | "invitationType" | "verificationStatus" | "preferredWindow"> & {
  mobile: string | null;
  altPhone: string | null;
  email: string | null;
  address: string | null;
  mapsUrl: string | null;
  lat: number | null;
  lng: number | null;
  deliveryInstructions: string | null;
  masked: boolean;
};

export function maskRecipient(r: Recipient, reveal: boolean): MaskedRecipient {
  return {
    id: r.id, code: r.code, nameAr: r.nameAr, nameEn: r.nameEn, honorific: r.honorific, jobTitle: r.jobTitle, organizationName: r.organizationName, vipTier: r.vipTier, category: r.category,
    city: r.city, district: r.district, priority: r.priority, invitationType: r.invitationType, verificationStatus: r.verificationStatus, preferredWindow: r.preferredWindow,
    mobile: reveal ? r.mobile : maskPhone(r.mobile),
    altPhone: reveal ? r.altPhone : maskPhone(r.altPhone),
    email: reveal ? r.email : r.email ? r.email.replace(/^(.).*(@.*)$/, "$1•••$2") : null,
    address: reveal ? r.address : r.address ? "•••" : null,
    mapsUrl: reveal ? r.mapsUrl : null,
    lat: reveal ? r.lat : null,
    lng: reveal ? r.lng : null,
    deliveryInstructions: reveal ? r.deliveryInstructions : r.deliveryInstructions ? "•••" : null,
    masked: !reveal,
  };
}

// ── Campaigns ───────────────────────────────────────────────────────────────

export const campaignSchema = z.object({
  id: z.string().optional(),
  projectId: z.string(),
  name: z.string().trim().min(2).max(200),
  invitationType: z.string().trim().max(100).nullish(),
  deliveryDeadline: z.coerce.date().nullish(),
  requireEvidence: z.boolean().default(true),
  requireReceiverName: z.boolean().default(true),
  maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
});

export async function saveCampaign(ctx: ServiceContext, input: z.output<typeof campaignSchema>) {
  assertCan(ctx, "delivery.dispatch");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.operate) throw new ForbiddenError();
    const ws = await tx.workstream.findFirst({ where: { projectId: input.projectId, kind: "VIP_DELIVERY" } });
    const data = { name: input.name, invitationType: input.invitationType ?? null, deliveryDeadline: input.deliveryDeadline ?? null, config: { requireEvidence: input.requireEvidence, requireReceiverName: input.requireReceiverName, maxAttempts: input.maxAttempts } };
    const c = input.id
      ? await tx.invitationCampaign.update({ where: { id: (await tx.invitationCampaign.findFirstOrThrow({ where: { id: input.id, projectId: input.projectId } })).id }, data })
      : await tx.invitationCampaign.create({ data: { ...data, organizationId: ctx.orgId, projectId: input.projectId, workstreamId: ws?.id ?? null, type: "PHYSICAL", createdById: ctx.userId } });
    await audit(tx, ctx, { action: input.id ? "campaign.update" : "campaign.create", entityType: "CAMPAIGN", entityId: c.id, projectId: input.projectId, after: data });
    return c;
  });
}

/** Generates one delivery card per selected recipient (skips recipients already in the campaign). */
export async function generateDeliveries(ctx: ServiceContext, input: { campaignId: string; recipientIds: string[] }) {
  assertCan(ctx, "delivery.dispatch");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const c = await tx.invitationCampaign.findUnique({ where: { id: input.campaignId } });
    if (!c || c.type !== "PHYSICAL") throw new NotFoundError();
    const scope = await projectScope(tx, ctx, c.projectId);
    if (!scope.operate) throw new ForbiddenError();
    const recipients = await tx.recipient.findMany({ where: { id: { in: input.recipientIds }, projectId: c.projectId, deletedAt: null } });
    const existing = new Set((await tx.delivery.findMany({ where: { campaignId: c.id, recipientId: { in: recipients.map((r) => r.id) } }, select: { recipientId: true } })).map((d) => d.recipientId));
    const fresh = recipients.filter((r) => !existing.has(r.id));
    const rows = fresh.map((r) => ({ id: createId(), organizationId: ctx.orgId, projectId: c.projectId, campaignId: c.id, recipientId: r.id, trackingCode: `DLV-${shortCode(7)}`, status: (r.address || r.mapsUrl || (r.lat != null && r.lng != null) ? "READY" : "PENDING") as DeliveryStatus, priority: r.priority }));
    if (rows.length) {
      await tx.delivery.createMany({ data: rows });
      await tx.deliveryEvent.createMany({ data: rows.map((d) => ({ organizationId: ctx.orgId, deliveryId: d.id, toStatus: d.status, actorId: ctx.userId, source: "WEB" })) });
    }
    await audit(tx, ctx, { action: "delivery.generate", entityType: "CAMPAIGN", entityId: c.id, projectId: c.projectId, summary: `${rows.length} cards (${existing.size} existing)` });
    return { created: rows.length, skipped: existing.size };
  });
}

// ── Queries ─────────────────────────────────────────────────────────────────

export interface DeliveryFilters {
  campaignId?: string;
  status?: string;
  agentId?: string;
  city?: string;
  district?: string;
  batchId?: string;
  q?: string;
}

export async function listDeliveries(ctx: ServiceContext, projectId: string, f: DeliveryFilters = {}) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
    assertCan(ctx, "delivery.view");
    const where: Prisma.DeliveryWhereInput = {
      projectId,
      ...(f.campaignId ? { campaignId: f.campaignId } : {}),
      ...(f.status ? { status: f.status as DeliveryStatus } : {}),
      ...(f.agentId ? { agentId: f.agentId === "none" ? null : f.agentId } : {}),
      ...(f.batchId ? { batchId: f.batchId } : {}),
      ...(f.city || f.district || f.q
        ? { recipient: { ...(f.city ? { city: f.city } : {}), ...(f.district ? { district: f.district } : {}), ...(f.q ? { OR: [{ nameAr: { contains: f.q, mode: "insensitive" } }, { nameEn: { contains: f.q, mode: "insensitive" } }, { code: { contains: f.q, mode: "insensitive" } }, { organizationName: { contains: f.q, mode: "insensitive" } }] } : {}) } }
        : {}),
    };
    const rows = await tx.delivery.findMany({
      where,
      include: { recipient: true, agent: { select: { id: true, name: true, nameAr: true } }, batch: { select: { id: true, code: true, name: true } } },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 5000,
    });
    return {
      scope,
      deliveries: rows.map((d) => ({
        id: d.id, trackingCode: d.trackingCode, status: d.status, priority: d.priority, attemptsCount: d.attemptsCount, campaignId: d.campaignId, version: d.version,
        scheduledFor: d.scheduledFor, deliveredAt: d.deliveredAt, failureReason: d.failureReason, escalatedAt: d.escalatedAt, updatedAt: d.updatedAt,
        agent: d.agent ? { id: d.agent.id, name: (ctx.locale === "ar" ? d.agent.nameAr : null) ?? d.agent.name } : null,
        batch: d.batch,
        recipient: maskRecipient(d.recipient, scope.vip),
      })),
    };
  });
}

export type DeliveryRow = Awaited<ReturnType<typeof listDeliveries>>["deliveries"][number];

export async function getDelivery(ctx: ServiceContext, deliveryId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const d = await tx.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        recipient: true,
        agent: { select: { id: true, name: true, nameAr: true } },
        batch: true,
        events: { orderBy: { createdAt: "asc" } },
        attempts: { orderBy: { attemptNo: "asc" } },
        assignments: { orderBy: { assignedAt: "desc" } },
        evidence: true,
      },
    });
    if (!d) throw new NotFoundError();
    const scope = await projectScope(tx, ctx, d.projectId);
    if (scope.clientView) throw new NotFoundError();
    if (scope.fieldOnly && d.agentId !== ctx.userId) throw new NotFoundError();
    if (!scope.fieldOnly) assertCan(ctx, "delivery.view");
    const reveal = scope.fieldOnly ? ACTIVE_FIELD_STATUSES.includes(d.status) : scope.vip;
    const [attachments, campaign, users] = await Promise.all([
      tx.attachment.findMany({ where: { entityType: "DELIVERY", entityId: d.id, deletedAt: null }, orderBy: { createdAt: "desc" } }),
      tx.invitationCampaign.findUniqueOrThrow({ where: { id: d.campaignId } }),
      tx.user.findMany({ where: { id: { in: [...new Set([...d.events.map((e) => e.actorId), ...d.attempts.map((a) => a.agentId), ...d.assignments.flatMap((a) => [a.agentId, a.assignedById])].filter((x): x is string => !!x))] } }, select: { id: true, name: true, nameAr: true } }),
    ]);
    return {
      delivery: { ...d, recipient: maskRecipient(d.recipient, reveal) },
      attachments,
      campaign: { id: campaign.id, name: campaign.name, config: campaignConfig(campaign.config), deliveryDeadline: campaign.deliveryDeadline },
      users: Object.fromEntries(users.map((u) => [u.id, (ctx.locale === "ar" ? u.nameAr : null) ?? u.name])),
      scope: { vip: scope.vip, fieldOnly: scope.fieldOnly, dispatch: can(ctx, "delivery.dispatch"), update: can(ctx, "delivery.update") },
    };
  });
}

/** Audited reveal of a recipient's full contact data (VIP privacy). */
export async function revealRecipient(ctx: ServiceContext, recipientId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const r = await tx.recipient.findUnique({ where: { id: recipientId } });
    if (!r || r.deletedAt) throw new NotFoundError();
    const scope = await projectScope(tx, ctx, r.projectId);
    if (!scope.vip) throw new ForbiddenError();
    await audit(tx, ctx, { action: "vip.contact_reveal", entityType: "RECIPIENT", entityId: r.id, projectId: r.projectId, summary: r.code });
    return maskRecipient(r, true);
  });
}

// ── Assignment & batches ────────────────────────────────────────────────────

export const assignSchema = z.object({
  projectId: z.string(),
  deliveryIds: z.array(z.string()).min(1).max(2000),
  agentId: z.string().nullable(),
  batchId: z.string().nullish(),
  overrideCapacity: z.boolean().default(false),
  reason: z.string().max(300).nullish(),
});

/**
 * Bulk assign / reassign / unassign in one transaction. Enforces: agent is an active field
 * agent (or staff) of the org; capacity (unless overridden); only assignable statuses move.
 */
export async function bulkAssign(ctx: ServiceContext, input: z.output<typeof assignSchema>) {
  assertCan(ctx, "delivery.dispatch");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.operate || scope.clientView) throw new ForbiddenError();
    const deliveries = await tx.delivery.findMany({ where: { id: { in: input.deliveryIds }, projectId: input.projectId } });
    if (input.batchId && !(await tx.deliveryBatch.findFirst({ where: { id: input.batchId, projectId: input.projectId } }))) throw new NotFoundError();
    const skipped: { id: string; reason: string }[] = [];
    let agentName: string | null = null;
    if (input.agentId) {
      const m = await tx.membership.findFirst({ where: { userId: input.agentId, status: "ACTIVE" }, include: { role: true, user: true } });
      if (!m || !["FIELD_AGENT", "EMPLOYEE", "TEAM_LEAD", "FREELANCER"].includes(m.role.baseRole)) throw new ValidationError("errors.validation", { agentId: ["errors.forbidden"] });
      agentName = m.user.name;
      const profile = await tx.resourceProfile.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: input.agentId } } });
      const open = await tx.delivery.count({ where: { agentId: input.agentId, status: { in: ACTIVE_FIELD_STATUSES } } });
      const incoming = deliveries.filter((d) => d.agentId !== input.agentId && ASSIGNABLE.includes(d.status)).length;
      const capacity = profile?.dailyCapacity ?? 25;
      if (!input.overrideCapacity && open + incoming > capacity) throw new AppError("delivery.overCapacity", "OVER_CAPACITY", 409, { capacity: [String(capacity)], open: [String(open)], incoming: [String(incoming)] });
      // field agents get minimal project membership so record-level scoping works
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: input.projectId, userId: input.agentId } },
        create: { organizationId: ctx.orgId, projectId: input.projectId, userId: input.agentId, role: m.role.baseRole === "FIELD_AGENT" ? "FIELD_AGENT" : "MEMBER", addedById: ctx.userId },
        update: {},
      });
    }
    let changed = 0;
    for (const d of deliveries) {
      if (input.agentId) {
        if (!ASSIGNABLE.includes(d.status)) { skipped.push({ id: d.id, reason: d.status }); continue; }
        if (d.agentId === input.agentId && d.status === "ASSIGNED") { if (input.batchId) await tx.delivery.update({ where: { id: d.id }, data: { batchId: input.batchId } }); continue; }
      } else if (!["ASSIGNED"].includes(d.status)) { skipped.push({ id: d.id, reason: d.status }); continue; }
      const to: DeliveryStatus = input.agentId ? "ASSIGNED" : "READY";
      const res = await tx.delivery.updateMany({ where: { id: d.id, version: d.version }, data: { agentId: input.agentId, status: to, ...(input.batchId ? { batchId: input.batchId } : {}), version: { increment: 1 } } });
      if (!res.count) { skipped.push({ id: d.id, reason: "CONFLICT" }); continue; }
      await tx.deliveryAssignment.updateMany({ where: { deliveryId: d.id, unassignedAt: null }, data: { unassignedAt: new Date(), reason: input.reason ?? null } });
      if (input.agentId) await tx.deliveryAssignment.create({ data: { organizationId: ctx.orgId, deliveryId: d.id, agentId: input.agentId, assignedById: ctx.userId, reason: input.reason ?? null } });
      if (d.status !== to) await tx.deliveryEvent.create({ data: { organizationId: ctx.orgId, deliveryId: d.id, fromStatus: d.status, toStatus: to, actorId: ctx.userId, reason: input.reason ?? null, note: agentName ? `→ ${agentName}` : null } });
      changed++;
    }
    await audit(tx, ctx, { action: input.agentId ? "delivery.assign" : "delivery.unassign", entityType: "DELIVERY", projectId: input.projectId, summary: `${changed} deliveries${agentName ? ` → ${agentName}` : ""}`, meta: { agentId: input.agentId, batchId: input.batchId, skipped: skipped.length } });
    if (input.agentId && changed) await emit(tx, ctx, "delivery.assigned", { projectId: input.projectId, agentId: input.agentId, count: changed, link: `/field` , entityType: "DELIVERY" });
    return { changed, skipped };
  });
}

export const batchSchema = z.object({ projectId: z.string(), campaignId: z.string(), name: z.string().trim().min(2).max(120), territory: z.string().trim().max(120).nullish(), plannedDate: z.coerce.date().nullish(), deliveryIds: z.array(z.string()).default([]) });

export async function createBatch(ctx: ServiceContext, input: z.output<typeof batchSchema>) {
  assertCan(ctx, "delivery.dispatch");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.operate) throw new ForbiddenError();
    if (!(await tx.invitationCampaign.findFirst({ where: { id: input.campaignId, projectId: input.projectId } }))) throw new NotFoundError();
    const b = await tx.deliveryBatch.create({ data: { organizationId: ctx.orgId, projectId: input.projectId, campaignId: input.campaignId, code: `BT-${shortCode(5)}`, name: input.name, territory: input.territory ?? null, plannedDate: input.plannedDate ?? null, createdById: ctx.userId } });
    if (input.deliveryIds.length) await tx.delivery.updateMany({ where: { id: { in: input.deliveryIds }, projectId: input.projectId }, data: { batchId: b.id } });
    await audit(tx, ctx, { action: "delivery.batch_create", entityType: "DELIVERY_BATCH", entityId: b.id, projectId: input.projectId, summary: `${b.code} ${b.name} (${input.deliveryIds.length})` });
    return b;
  });
}

// ── Status updates (office + field + offline replay) ────────────────────────

export const statusSchema = z.object({
  deliveryId: z.string(),
  to: z.enum(["PENDING", "VALIDATING", "READY", "ASSIGNED", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED_ATTEMPT", "RESCHEDULED", "RETURNED", "CANCELLED"]),
  version: z.number().int().optional(),
  reason: z.enum(FAILURE_REASONS).nullish(),
  note: z.string().trim().max(2000).nullish(),
  receivedByName: z.string().trim().max(200).nullish(),
  receivedByRelation: z.string().trim().max(100).nullish(),
  scheduledFor: z.coerce.date().nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  evidenceIds: z.array(z.string()).max(10).default([]),
  clientMutationId: z.string().min(8).max(100).nullish(),
  occurredAt: z.coerce.date().nullish(),
  source: z.enum(["WEB", "FIELD", "FIELD_OFFLINE"]).default("WEB"),
});

export type StatusInput = z.output<typeof statusSchema>;

export class DeliveryConflictError extends AppError {
  constructor(public current: { status: DeliveryStatus; version: number }) {
    super("errors.conflict", "CONFLICT", 409);
  }
}

export async function updateDeliveryStatus(ctx: ServiceContext, input: StatusInput) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => updateDeliveryStatusTx(tx, ctx, input));
}

export async function updateDeliveryStatusTx(tx: Tx, ctx: ServiceContext, input: StatusInput) {
  // idempotent replay of offline mutations
  if (input.clientMutationId) {
    const seen = await tx.deliveryEvent.findUnique({ where: { clientMutationId: input.clientMutationId } });
    if (seen) {
      const d = await tx.delivery.findUniqueOrThrow({ where: { id: seen.deliveryId } });
      return { delivery: d, replayed: true };
    }
  }
  const d = await tx.delivery.findUnique({ where: { id: input.deliveryId }, include: { recipient: { select: { code: true, nameAr: true, nameEn: true } } } });
  if (!d) throw new NotFoundError();
  const scope: ProjectScope = await projectScope(tx, ctx, d.projectId);
  const field = scope.fieldOnly;
  if (field) {
    if (!can(ctx, "delivery.field") || d.agentId !== ctx.userId) throw new NotFoundError();
  } else if (!can(ctx, "delivery.update") && !can(ctx, "delivery.dispatch")) throw new ForbiddenError();
  if (scope.clientView) throw new NotFoundError();
  if (input.version !== undefined && input.version !== d.version) throw new DeliveryConflictError({ status: d.status, version: d.version });
  if (!canTransition(d.status, input.to, field)) throw new ValidationError("errors.invalidTransition", { to: [`${d.status}→${input.to}`] });
  const campaign = await tx.invitationCampaign.findUniqueOrThrow({ where: { id: d.campaignId } });
  const cfg = campaignConfig(campaign.config);
  if (input.to === "ASSIGNED" && !d.agentId) throw new ValidationError("errors.validation", { agentId: ["common.required"] });
  if (input.to === "FAILED_ATTEMPT" && !input.reason) throw new ValidationError("errors.validation", { reason: ["common.required"] });
  if (input.to === "RESCHEDULED" && !input.scheduledFor) throw new ValidationError("errors.validation", { scheduledFor: ["common.required"] });
  if (input.to === "DELIVERED") {
    if (cfg.requireReceiverName && !input.receivedByName) throw new ValidationError("errors.validation", { receivedByName: ["common.required"] });
    if (cfg.requireEvidence) {
      const existing = await tx.attachment.count({ where: { entityType: "DELIVERY", entityId: d.id, kind: "EVIDENCE", deletedAt: null, ...(input.evidenceIds.length ? { id: { in: input.evidenceIds } } : {}) } });
      if (!existing) throw new ValidationError("delivery.evidenceRequired", { evidence: ["delivery.evidenceRequired"] });
    }
  }
  const occurredAt = input.occurredAt && input.occurredAt <= new Date(Date.now() + 5 * 60_000) ? input.occurredAt : new Date();
  const outcome = ATTEMPT_OUTCOMES[input.to];
  const attemptNo = outcome ? d.attemptsCount + 1 : d.attemptsCount;
  const res = await tx.delivery.updateMany({
    where: { id: d.id, version: d.version },
    data: {
      status: input.to,
      version: { increment: 1 },
      ...(outcome ? { attemptsCount: attemptNo } : {}),
      ...(input.to === "DELIVERED" ? { deliveredAt: occurredAt, receivedByName: input.receivedByName ?? null, receivedByRelation: input.receivedByRelation ?? null, failureReason: null } : {}),
      ...(input.to === "FAILED_ATTEMPT" || input.to === "RETURNED" ? { failureReason: input.reason ?? null } : {}),
      ...(input.to === "RESCHEDULED" ? { scheduledFor: input.scheduledFor ?? null } : {}),
      ...(input.to === "CANCELLED" || input.to === "READY" ? { agentId: input.to === "READY" ? null : d.agentId } : {}),
      ...(input.note ? { notes: input.note } : {}),
    },
  });
  if (!res.count) {
    const cur = await tx.delivery.findUniqueOrThrow({ where: { id: d.id } });
    throw new DeliveryConflictError({ status: cur.status, version: cur.version });
  }
  let attemptId: string | null = null;
  if (outcome) {
    const a = await tx.deliveryAttempt.create({
      data: { organizationId: ctx.orgId, deliveryId: d.id, attemptNo, agentId: d.agentId ?? ctx.userId, outcome, failureReason: input.reason ?? null, notes: input.note ?? null, receivedByName: input.receivedByName ?? null, lat: input.lat ?? null, lng: input.lng ?? null, occurredAt, clientMutationId: input.clientMutationId ? `${input.clientMutationId}:attempt` : null },
    });
    attemptId = a.id;
  }
  if (input.evidenceIds.length) {
    const atts = await tx.attachment.findMany({ where: { id: { in: input.evidenceIds }, entityType: "DELIVERY", entityId: d.id } });
    if (atts.length) await tx.deliveryEvidence.createMany({ data: atts.map((a) => ({ organizationId: ctx.orgId, deliveryId: d.id, attemptId, attachmentId: a.id, kind: a.mimeType.startsWith("image/") ? "PHOTO" : "DOCUMENT" })) });
  }
  await tx.deliveryEvent.create({ data: { organizationId: ctx.orgId, deliveryId: d.id, fromStatus: d.status, toStatus: input.to, actorId: ctx.userId, reason: input.reason ?? null, note: input.note ?? null, source: input.source, clientMutationId: input.clientMutationId ?? null, createdAt: occurredAt } });
  if (input.to === "READY" && d.agentId) await tx.deliveryAssignment.updateMany({ where: { deliveryId: d.id, unassignedAt: null }, data: { unassignedAt: new Date() } });
  await audit(tx, ctx, { action: "delivery.status_change", entityType: "DELIVERY", entityId: d.id, projectId: d.projectId, summary: `${d.trackingCode} ${d.status} → ${input.to}`, before: { status: d.status }, after: { status: input.to, reason: input.reason, attemptNo: outcome ? attemptNo : undefined }, meta: { source: input.source, offline: input.source === "FIELD_OFFLINE" } });
  const payload = { deliveryId: d.id, projectId: d.projectId, campaignId: d.campaignId, code: d.trackingCode, title: d.recipient.nameAr ?? d.recipient.nameEn ?? d.recipient.code, reason: input.reason ?? null, attemptsCount: attemptNo, agentId: d.agentId, link: `/projects/${d.projectId}/delivery/cards/${d.id}`, entityType: "DELIVERY", entityId: d.id };
  if (input.to === "FAILED_ATTEMPT" || input.to === "RETURNED") await emit(tx, ctx, "delivery.failed", payload);
  if (input.to === "DELIVERED") await emit(tx, ctx, "delivery.delivered", payload);
  const updated = await tx.delivery.findUniqueOrThrow({ where: { id: d.id } });
  return { delivery: updated, replayed: false };
}

export async function escalateDelivery(ctx: ServiceContext, input: { deliveryId: string; note: string }) {
  assertCan(ctx, "delivery.dispatch");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const d = await tx.delivery.findUnique({ where: { id: input.deliveryId } });
    if (!d) throw new NotFoundError();
    await projectScope(tx, ctx, d.projectId);
    await tx.delivery.update({ where: { id: d.id }, data: { escalatedAt: new Date(), escalationNote: input.note, version: { increment: 1 } } });
    await tx.deliveryEvent.create({ data: { organizationId: ctx.orgId, deliveryId: d.id, fromStatus: d.status, toStatus: d.status, actorId: ctx.userId, reason: "ESCALATED", note: input.note } });
    await audit(tx, ctx, { action: "delivery.escalate", entityType: "DELIVERY", entityId: d.id, projectId: d.projectId, summary: input.note });
    await emit(tx, ctx, "delivery.failed", { deliveryId: d.id, projectId: d.projectId, campaignId: d.campaignId, code: d.trackingCode, reason: input.note, link: `/projects/${d.projectId}/delivery/cards/${d.id}`, entityType: "DELIVERY", entityId: d.id });
  });
}

// ── Field workspace ─────────────────────────────────────────────────────────

/** The agent's own work only, with contact data exposed solely for active deliveries. */
export async function myFieldDeliveries(ctx: ServiceContext) {
  assertCan(ctx, "delivery.field");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const since = new Date(Date.now() - 3 * 86400_000);
    const rows = await tx.delivery.findMany({
      where: { agentId: ctx.userId, OR: [{ status: { in: ACTIVE_FIELD_STATUSES } }, { status: { in: ["DELIVERED", "RETURNED"] }, updatedAt: { gte: since } }] },
      include: { recipient: true, batch: { select: { code: true, name: true } }, attempts: { select: { attemptNo: true, outcome: true, failureReason: true, occurredAt: true }, orderBy: { attemptNo: "desc" }, take: 3 } },
      orderBy: [{ status: "asc" }, { priority: "desc" }, { scheduledFor: "asc" }],
      take: 300,
    });
    const campaigns = await tx.invitationCampaign.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.campaignId))] } }, select: { id: true, name: true, config: true } });
    return rows.map((d) => {
      const active = ACTIVE_FIELD_STATUSES.includes(d.status);
      const r = maskRecipient(d.recipient, active);
      const c = campaigns.find((x) => x.id === d.campaignId);
      return {
        id: d.id, trackingCode: d.trackingCode, status: d.status, version: d.version, priority: d.priority, attemptsCount: d.attemptsCount, scheduledFor: d.scheduledFor, deliveredAt: d.deliveredAt, batch: d.batch, attempts: d.attempts,
        campaign: c ? { name: c.name, ...campaignConfig(c.config) } : null,
        // data minimization: no email, no org-internal notes, no VIP tier labels beyond what is needed
        recipient: { code: r.code, name: r.nameAr ?? r.nameEn, nameEn: r.nameEn, honorific: r.honorific, organizationName: r.organizationName, city: r.city, district: r.district, address: r.address, mapsUrl: r.mapsUrl, lat: r.lat, lng: r.lng, mobile: r.mobile, altPhone: r.altPhone, deliveryInstructions: r.deliveryInstructions, preferredWindow: r.preferredWindow, masked: r.masked },
      };
    });
  });
}

export type FieldDelivery = Awaited<ReturnType<typeof myFieldDeliveries>>[number];

/** Applies a queue of offline mutations; each is independent, idempotent and conflict-checked. */
export async function syncFieldMutations(ctx: ServiceContext, mutations: StatusInput[]) {
  const results: { clientMutationId: string | null | undefined; ok: boolean; status?: DeliveryStatus; version?: number; conflict?: { status: DeliveryStatus; version: number }; error?: string; replayed?: boolean }[] = [];
  for (const m of mutations.slice(0, 100)) {
    try {
      const r = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => updateDeliveryStatusTx(tx, ctx, { ...m, source: m.source === "WEB" ? "FIELD" : m.source }));
      results.push({ clientMutationId: m.clientMutationId, ok: true, status: r.delivery.status, version: r.delivery.version, replayed: r.replayed });
    } catch (e) {
      if (e instanceof DeliveryConflictError) results.push({ clientMutationId: m.clientMutationId, ok: false, conflict: e.current, error: e.message });
      else results.push({ clientMutationId: m.clientMutationId, ok: false, error: e instanceof AppError ? e.message : "errors.unexpected" });
    }
  }
  return results;
}

// ── Recipient registry ──────────────────────────────────────────────────────

export async function listRecipients(ctx: ServiceContext, opts: { projectId?: string; q?: string; take?: number } = {}) {
  assertCan(ctx, "recipient.view");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    let scopeVip = false;
    let projectIds: string[];
    if (opts.projectId) {
      const s = await projectScope(tx, ctx, opts.projectId);
      if (s.clientView || s.fieldOnly) throw new NotFoundError();
      scopeVip = s.vip;
      projectIds = [opts.projectId];
    } else {
      const { projectVisibilityWhere } = await import("@/server/authz/policy");
      projectIds = (await tx.project.findMany({ where: projectVisibilityWhere(ctx), select: { id: true } })).map((p) => p.id);
      scopeVip = can(ctx, "vip.viewSensitive") && can(ctx, "project.viewAll");
    }
    const ci = opts.q ? { contains: opts.q, mode: "insensitive" as const } : undefined;
    const rows = await tx.recipient.findMany({
      where: { projectId: { in: projectIds }, deletedAt: null, ...(ci ? { OR: [{ nameAr: ci }, { nameEn: ci }, { code: ci }, { organizationName: ci }, { city: ci }, { district: ci }] } : {}) },
      include: { deliveries: { select: { id: true, status: true, campaignId: true, trackingCode: true } } },
      orderBy: { createdAt: "desc" },
      take: Math.min(opts.take ?? 3000, 5000),
    });
    const projects = await tx.project.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.projectId))] } }, select: { id: true, code: true, name: true } });
    return { vip: scopeVip, rows: rows.map((r) => ({ ...maskRecipient(r, scopeVip), projectId: r.projectId, project: projects.find((p) => p.id === r.projectId)!, createdAt: r.createdAt, deliveries: r.deliveries, importBatchId: r.importBatchId, retentionUntil: r.retentionUntil, anonymized: !!r.anonymizedAt })) };
  });
}

export const recipientPatchSchema = z.object({
  id: z.string(),
  nameAr: z.string().trim().max(200).nullish(),
  nameEn: z.string().trim().max(200).nullish(),
  honorific: z.string().trim().max(100).nullish(),
  jobTitle: z.string().trim().max(200).nullish(),
  organizationName: z.string().trim().max(200).nullish(),
  vipTier: z.string().trim().max(50).nullish(),
  mobile: z.string().trim().max(30).nullish(),
  address: z.string().trim().max(500).nullish(),
  city: z.string().trim().max(100).nullish(),
  district: z.string().trim().max(100).nullish(),
  mapsUrl: z.string().trim().max(1000).nullish(),
  deliveryInstructions: z.string().trim().max(1000).nullish(),
  preferredWindow: z.string().trim().max(100).nullish(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  verificationStatus: z.enum(["UNVERIFIED", "VERIFIED", "INVALID"]).optional(),
  notes: z.string().trim().max(2000).nullish(),
});

export async function updateRecipient(ctx: ServiceContext, input: z.output<typeof recipientPatchSchema>) {
  assertCan(ctx, "recipient.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const r = await tx.recipient.findUnique({ where: { id: input.id } });
    if (!r || r.deletedAt) throw new NotFoundError();
    const scope = await projectScope(tx, ctx, r.projectId);
    if (!scope.operate) throw new ForbiddenError();
    const { id, mobile, mapsUrl, ...rest } = input;
    const data: Prisma.RecipientUpdateInput = { ...rest };
    // contact fields require VIP visibility (you cannot overwrite what you cannot see)
    if (mobile !== undefined || mapsUrl !== undefined || rest.address !== undefined) {
      if (!scope.vip) throw new ForbiddenError();
      if (mobile !== undefined) {
        const { normalizeSaudiPhone } = await import("@/lib/phone");
        const p = normalizeSaudiPhone(mobile);
        if (mobile && !p.valid) throw new ValidationError("errors.validation", { mobile: ["importErrors.MOBILE_INVALID"] });
        data.mobile = p.e164;
        data.mobileRaw = mobile;
      }
      if (mapsUrl !== undefined) {
        const { isSafeMapsUrl, coordsFromMapsUrl } = await import("./imports/normalize");
        if (mapsUrl && !isSafeMapsUrl(mapsUrl)) throw new ValidationError("errors.validation", { mapsUrl: ["importErrors.MAPS_URL_INVALID"] });
        data.mapsUrl = mapsUrl || null;
        const c = mapsUrl ? coordsFromMapsUrl(mapsUrl) : null;
        if (c) { data.lat = c.lat; data.lng = c.lng; }
      }
    }
    const updated = await tx.recipient.update({ where: { id }, data });
    const changed = Object.keys(input).filter((k) => k !== "id");
    await audit(tx, ctx, { action: "recipient.update", entityType: "RECIPIENT", entityId: id, projectId: r.projectId, summary: `${r.code}: ${changed.join(", ")}`, before: Object.fromEntries(changed.map((k) => [k, (r as Record<string, unknown>)[k]])), after: Object.fromEntries(changed.map((k) => [k, (updated as Record<string, unknown>)[k]])) });
    return maskRecipient(updated, scope.vip);
  });
}

/** PDPL-aware erasure: personal data is wiped, operational history (codes, statuses) is kept. */
export async function anonymizeRecipients(ctx: ServiceContext, input: { projectId: string; recipientIds?: string[]; expiredOnly?: boolean }) {
  assertCan(ctx, "recipient.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.manage) throw new ForbiddenError();
    const where: Prisma.RecipientWhereInput = { projectId: input.projectId, anonymizedAt: null, ...(input.recipientIds ? { id: { in: input.recipientIds } } : {}), ...(input.expiredOnly ? { retentionUntil: { lt: new Date() } } : {}) };
    const r = await tx.recipient.updateMany({
      where,
      data: { nameAr: null, nameEn: null, honorific: null, jobTitle: null, mobile: null, mobileRaw: null, altPhone: null, email: null, address: null, mapsUrl: null, lat: null, lng: null, deliveryInstructions: null, notes: null, matchKey: null, externalRef: null, anonymizedAt: new Date() },
    });
    await audit(tx, ctx, { action: "recipient.anonymize", entityType: "RECIPIENT", projectId: input.projectId, summary: `${r.count} recipients anonymized`, meta: { expiredOnly: input.expiredOnly } });
    return { anonymized: r.count };
  });
}

export async function listAgents(ctx: ServiceContext) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const members = await tx.membership.findMany({ where: { status: "ACTIVE", role: { baseRole: { in: ["FIELD_AGENT"] } } }, include: { user: { select: { id: true, name: true, nameAr: true } } } });
    const ids = members.map((m) => m.userId);
    const [profiles, loads, delivered] = await Promise.all([
      tx.resourceProfile.findMany({ where: { userId: { in: ids } } }),
      tx.delivery.groupBy({ by: ["agentId"], where: { agentId: { in: ids }, status: { in: ACTIVE_FIELD_STATUSES } }, _count: true }),
      tx.delivery.groupBy({ by: ["agentId"], where: { agentId: { in: ids }, status: "DELIVERED", deliveredAt: { gte: new Date(Date.now() - 86400_000) } }, _count: true }),
    ]);
    return members.map((m) => {
      const p = profiles.find((x) => x.userId === m.userId);
      return { id: m.userId, name: (ctx.locale === "ar" ? m.user.nameAr : null) ?? m.user.name, capacity: p?.dailyCapacity ?? 25, territories: p?.territories ?? [], vehicle: p?.vehicle ?? null, open: loads.find((l) => l.agentId === m.userId)?._count ?? 0, deliveredToday: delivered.find((l) => l.agentId === m.userId)?._count ?? 0 };
    });
  });
}
