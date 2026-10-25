import type { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { randomToken, sha256Hex } from "@/server/auth/crypto";
import { revokeAllSessions } from "@/server/auth/session-store";
import type { ServiceContext } from "@/server/authz/context";
import { ALL_PERMISSIONS } from "@/server/authz/permissions";
import { assertCan, can } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { emit } from "@/server/modules/automation/outbox";
import { notify } from "@/server/modules/notifications/notify";
import { executeHandover, memberHoldings, type HandoverOptions, type HandoverResult, type Holdings } from "./handover";
import type { clientSchema, contactSchema, customFieldSchema, inviteSchema, orgSettingsSchema, roleSchema, teamSchema, venueSchema } from "./schemas";

const INVITE_TTL_DAYS = 14;

// ── Organization ────────────────────────────────────────────────────────────

export async function getOrganization(ctx: ServiceContext) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: ctx.orgId } });
    if (!org) throw new NotFoundError();
    return org;
  });
}

export interface OrgSettings {
  financeApprovalThreshold: number;
  recipientRetentionDays: number;
}

export function readSettings(raw: unknown): OrgSettings {
  const s = (raw ?? {}) as Partial<OrgSettings>;
  return { financeApprovalThreshold: Number(s.financeApprovalThreshold ?? 50000), recipientRetentionDays: Number(s.recipientRetentionDays ?? 365) };
}

export async function updateOrganization(ctx: ServiceContext, input: z.output<typeof orgSettingsSchema>) {
  assertCan(ctx, "org.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const before = await tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId } });
    const { financeApprovalThreshold, recipientRetentionDays, email, ...rest } = input;
    const settings = { ...((before.settings as object) ?? {}), financeApprovalThreshold, recipientRetentionDays };
    const org = await tx.organization.update({ where: { id: ctx.orgId }, data: { ...rest, email: email || null, settings: settings as Prisma.InputJsonValue } });
    await audit(tx, ctx, { action: "org.update", entityType: "ORGANIZATION", entityId: ctx.orgId, before: { name: before.name, brandColor: before.brandColor, settings: before.settings }, after: { name: org.name, brandColor: org.brandColor, settings } });
    return org;
  });
}

// ── Members & invitations ───────────────────────────────────────────────────

export async function listMembers(ctx: ServiceContext) {
  assertCan(ctx, "org.members.view");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const [members, invitations, roles, clients, vendors] = await Promise.all([
      tx.membership.findMany({
        where: { organizationId: ctx.orgId },
        include: { user: { select: { id: true, name: true, nameAr: true, email: true, lastLoginAt: true } }, role: true },
        orderBy: { joinedAt: "asc" },
      }),
      tx.invitation.findMany({ where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }),
      tx.role.findMany({ orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }] }),
      tx.client.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
      tx.vendor.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    return { members, invitations, roles, clients, vendors };
  });
}

/** Lightweight member directory used by pickers (assignee, owner, agent…). */
export async function memberDirectory(ctx: ServiceContext, opts: { baseRoles?: string[] } = {}) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const members = await tx.membership.findMany({
      where: { organizationId: ctx.orgId, status: "ACTIVE", ...(opts.baseRoles ? { role: { baseRole: { in: opts.baseRoles as never } } } : {}) },
      include: { user: { select: { id: true, name: true, nameAr: true, email: true } }, role: { select: { baseRole: true, nameAr: true, nameEn: true } } },
    });
    return members.map((m) => ({ id: m.user.id, name: (ctx.locale === "ar" ? m.user.nameAr : null) ?? m.user.name, email: m.user.email, baseRole: m.role.baseRole, roleName: ctx.locale === "ar" ? m.role.nameAr : m.role.nameEn }));
  });
}

export async function inviteMember(ctx: ServiceContext, input: z.output<typeof inviteSchema>) {
  assertCan(ctx, "org.members.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const role = await tx.role.findUnique({ where: { id: input.roleId } });
    if (!role) throw new ValidationError("errors.validation", { roleId: ["errors.notFound"] });
    if (role.baseRole === "OWNER" && ctx.role !== "OWNER") throw new ForbiddenError();
    if ((role.baseRole === "CLIENT" || role.baseRole === "CLIENT_APPROVER") && !input.clientId) throw new ValidationError("errors.validation", { clientId: ["common.required"] });
    if (role.baseRole === "VENDOR" && !input.vendorId) throw new ValidationError("errors.validation", { vendorId: ["common.required"] });
    const existingUser = await tx.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (existingUser) {
      const m = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: existingUser.id } } });
      if (m && m.status === "ACTIVE") throw new ConflictError("errors.alreadyMember");
    }
    if (input.projectId) {
      const p = await tx.project.findUnique({ where: { id: input.projectId }, select: { id: true } });
      if (!p) throw new NotFoundError();
    }
    // supersede previous pending invitations for this email
    await tx.invitation.updateMany({ where: { email: input.email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000);
    const inv = await tx.invitation.create({
      data: { organizationId: ctx.orgId, email: input.email, name: input.name, roleId: role.id, clientId: input.clientId ?? null, vendorId: input.vendorId ?? null, projectId: input.projectId ?? null, projectRole: input.projectRole ?? null, invitedById: ctx.userId, expiresAt },
    });
    const token = randomToken(32);
    await tx.publicToken.create({ data: { id: sha256Hex(token), kind: "INVITATION", organizationId: ctx.orgId, refId: inv.id, expiresAt } });
    // Email delivery goes through the email adapter (simulation unless SMTP is configured).
    await tx.messageJob.create({
      data: {
        organizationId: ctx.orgId,
        channel: "EMAIL",
        provider: process.env.SMTP_URL ? "smtp" : "simulation",
        simulated: !process.env.SMTP_URL,
        to: input.email,
        subject: `Invitation to ${ctx.orgName}`,
        body: `/invite/${token}`,
        status: "SENT",
        sentAt: new Date(),
        idempotencyKey: `invite:${inv.id}`,
      },
    });
    await audit(tx, ctx, { action: "member.invite", entityType: "INVITATION", entityId: inv.id, summary: `${input.email} → ${role.key}`, meta: { roleKey: role.key, projectId: input.projectId } });
    await emit(tx, ctx, "member.invited", { email: input.email, roleKey: role.key });
    return { invitationId: inv.id, token, link: `/invite/${token}` };
  });
}

export async function revokeInvitation(ctx: ServiceContext, invitationId: string) {
  assertCan(ctx, "org.members.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const r = await tx.invitation.updateMany({ where: { id: invitationId, acceptedAt: null }, data: { revokedAt: new Date() } });
    if (!r.count) throw new NotFoundError();
    await tx.publicToken.updateMany({ where: { refId: invitationId, kind: "INVITATION" }, data: { usedAt: new Date() } });
    await audit(tx, ctx, { action: "member.invite_revoke", entityType: "INVITATION", entityId: invitationId });
  });
}

async function assertNotLastOwner(tx: Prisma.TransactionClient, membershipId: string) {
  const m = await tx.membership.findUnique({ where: { id: membershipId }, include: { role: true } });
  if (!m) throw new NotFoundError();
  if (m.role.baseRole === "OWNER") {
    const owners = await tx.membership.count({ where: { status: "ACTIVE", role: { baseRole: "OWNER" } } });
    if (owners <= 1) throw new ConflictError("errors.lastOwner");
  }
  return m;
}

export async function changeMemberRole(ctx: ServiceContext, input: { membershipId: string; roleId: string; clientId?: string | null; vendorId?: string | null }) {
  assertCan(ctx, "org.members.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const role = await tx.role.findUnique({ where: { id: input.roleId } });
    if (!role) throw new NotFoundError();
    if (role.baseRole === "OWNER" && ctx.role !== "OWNER") throw new ForbiddenError();
    const before = await tx.membership.findFirst({ where: { id: input.membershipId, organizationId: ctx.orgId }, include: { role: true } });
    if (!before) throw new NotFoundError();
    if (before.userId === ctx.userId) throw new ForbiddenError(); // no self role change
    if (before.role.baseRole === "OWNER" && ctx.role !== "OWNER") throw new ForbiddenError(); // only an owner changes an owner
    if (before.role.baseRole === "OWNER" && role.baseRole !== "OWNER") await assertNotLastOwner(tx, before.id);
    const clientId = input.clientId ?? before.clientId;
    const vendorId = input.vendorId ?? before.vendorId;
    if (clientId && clientId !== before.clientId && !(await tx.client.findUnique({ where: { id: clientId }, select: { id: true } }))) throw new ValidationError("errors.validation", { clientId: ["errors.notFound"] });
    if (vendorId && vendorId !== before.vendorId && !(await tx.vendor.findUnique({ where: { id: vendorId }, select: { id: true } }))) throw new ValidationError("errors.validation", { vendorId: ["errors.notFound"] });
    await tx.membership.update({ where: { id: before.id }, data: { roleId: role.id, clientId, vendorId } });
    await audit(tx, ctx, { action: "member.role_change", entityType: "MEMBERSHIP", entityId: before.id, before: { role: before.role.key, clientId: before.clientId, vendorId: before.vendorId }, after: { role: role.key, clientId, vendorId }, meta: { userId: before.userId } });
  });
}

/**
 * The handover preview for a member (HO rule 1): H1–H15 with counts and items per project, from
 * the same `memberHoldings` query the execution uses (HO-9).
 */
export async function handoverPreview(ctx: ServiceContext, membershipId: string): Promise<Holdings & { member: { id: string; name: string; role: string; status: string; lastLoginAt: Date | null } }> {
  assertCan(ctx, "org.members.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const m = await tx.membership.findFirst({ where: { id: membershipId, organizationId: ctx.orgId }, include: { role: true, user: { select: { name: true, nameAr: true, lastLoginAt: true } } } });
    if (!m) throw new NotFoundError();
    const h = await memberHoldings(tx, ctx.orgId, m.userId);
    return { ...h, member: { id: m.id, name: (ctx.locale === "ar" ? m.user.nameAr : null) ?? m.user.name, role: m.role.key, status: m.status, lastLoginAt: m.user.lastLoginAt } };
  });
}

/**
 * Suspend, revoke or reactivate a member (§2). Leaving runs the handover in the same transaction
 * (HO rule 1); the last active PM of a live project can't leave without a replacement PM (HO rule 3);
 * REVOKED is final (HO rule 5) and reactivation hands nothing back.
 */
export async function setMemberStatus(ctx: ServiceContext, input: { membershipId: string; status: "ACTIVE" | "SUSPENDED" | "REVOKED"; handover?: HandoverOptions | null }) {
  assertCan(ctx, "org.members.manage");
  const { userId, handover } = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const target = await tx.membership.findFirst({ where: { id: input.membershipId, organizationId: ctx.orgId }, include: { role: true, user: { select: { name: true } } } });
    if (!target) throw new NotFoundError();
    if (target.userId === ctx.userId) throw new ForbiddenError(); // nobody changes their own status
    if (target.role.baseRole === "OWNER" && ctx.role !== "OWNER") throw new ForbiddenError(); // only an owner suspends an owner
    if (input.status === "ACTIVE" && target.status === "REVOKED") throw new ValidationError("errors.revokedIsFinal");
    if (input.status === target.status) return { userId: target.userId, handover: null };
    const m = input.status === "ACTIVE" ? target : await assertNotLastOwner(tx, target.id);
    await tx.membership.update({ where: { id: m.id }, data: { status: input.status, revokedAt: input.status === "REVOKED" ? new Date() : null } });
    let result: HandoverResult | null = null;
    if (input.status !== "ACTIVE" && target.status === "ACTIVE") {
      result = await executeHandover(tx, ctx, { userId: m.userId, name: target.user.name }, input.handover ?? {});
      await releaseDeliveries(tx, ctx, m.userId);
      // §2.3: suspending or revoking an owner is told to the other owners
      if (target.role.baseRole === "OWNER") {
        const owners = await tx.membership.findMany({ where: { organizationId: ctx.orgId, status: "ACTIVE", role: { baseRole: "OWNER" }, userId: { notIn: [m.userId] } }, select: { userId: true } });
        await notify(tx, { orgId: ctx.orgId, userIds: owners.map((o) => o.userId), type: "member.departed", titleKey: input.status === "REVOKED" ? "org.handover.notices.ownerRevoked" : "org.handover.notices.ownerSuspended", params: { name: target.user.name }, link: "/settings/members", excludeUserId: ctx.userId, mandatory: true });
      }
    }
    await audit(tx, ctx, { action: `member.${input.status.toLowerCase()}`, entityType: "MEMBERSHIP", entityId: m.id, before: { status: target.status }, after: { status: input.status }, meta: { userId: m.userId } });
    return { userId: m.userId, handover: result };
  }, { timeout: 60_000 });
  // Membership checks happen per request, so access ends immediately; additionally terminate
  // sessions if the user has no other active membership.
  if (input.status !== "ACTIVE") {
    const { listUserOrganizations } = await import("@/server/authz/load-context");
    const remaining = await listUserOrganizations(userId);
    if (!remaining.length) await revokeAllSessions(userId);
  }
  return handover;
}

/**
 * H14, always automatic (M1): when someone leaves, their not-yet-started deliveries go back to
 * dispatch with history and deliveries already in their car are escalated to dispatch. No automatic
 * re-assignment to another driver. Designated approvals are handed over by `executeHandover` (H3).
 */
async function releaseDeliveries(tx: Prisma.TransactionClient, ctx: ServiceContext, userId: string) {
  const now = new Date();
  const assigned = await tx.delivery.findMany({ where: { agentId: userId, status: "ASSIGNED" }, select: { id: true, version: true, status: true } });
  for (const d of assigned) {
    const r = await tx.delivery.updateMany({ where: { id: d.id, version: d.version }, data: { agentId: null, status: "READY", version: { increment: 1 } } });
    if (!r.count) continue;
    await tx.deliveryAssignment.updateMany({ where: { deliveryId: d.id, unassignedAt: null }, data: { unassignedAt: now, reason: "member_inactive" } });
    await tx.deliveryEvent.create({ data: { organizationId: ctx.orgId, deliveryId: d.id, fromStatus: "ASSIGNED", toStatus: "READY", actorId: ctx.userId, reason: "MEMBER_INACTIVE", source: "WEB" } });
  }
  const inFlight = await tx.delivery.findMany({ where: { agentId: userId, status: { in: ["OUT_FOR_DELIVERY", "FAILED_ATTEMPT", "RESCHEDULED"] } }, select: { id: true, status: true, projectId: true, campaignId: true, trackingCode: true } });
  for (const d of inFlight) {
    await tx.delivery.update({ where: { id: d.id }, data: { escalatedAt: now, escalationNote: "agent_inactive", version: { increment: 1 } } });
    await tx.deliveryEvent.create({ data: { organizationId: ctx.orgId, deliveryId: d.id, fromStatus: d.status, toStatus: d.status, actorId: ctx.userId, reason: "ESCALATED", note: "agent_inactive", source: "WEB" } });
    await emit(tx, ctx, "delivery.failed", { deliveryId: d.id, projectId: d.projectId, campaignId: d.campaignId, code: d.trackingCode, reason: "agent_inactive", link: `/projects/${d.projectId}/delivery/cards/${d.id}`, entityType: "DELIVERY", entityId: d.id });
  }
  if (assigned.length || inFlight.length) await audit(tx, ctx, { action: "delivery.release_inactive_agent", entityType: "DELIVERY", summary: `${assigned.length} released, ${inFlight.length} escalated`, meta: { userId, cause: "handover" } });
}

// ── Roles ───────────────────────────────────────────────────────────────────

export async function saveRole(ctx: ServiceContext, input: z.output<typeof roleSchema>) {
  assertCan(ctx, "org.roles.manage");
  const permissions = input.permissions.filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    if (input.id) {
      const existing = await tx.role.findUnique({ where: { id: input.id } });
      if (!existing) throw new NotFoundError();
      if (existing.isSystem && existing.baseRole === "OWNER") throw new ForbiddenError();
      const role = await tx.role.update({ where: { id: input.id }, data: { nameAr: input.nameAr, nameEn: input.nameEn, permissions } });
      await audit(tx, ctx, { action: "role.update", entityType: "ROLE", entityId: role.id, before: { permissions: existing.permissions }, after: { permissions } });
      return role;
    }
    const key = `custom-${Date.now().toString(36)}`;
    const role = await tx.role.create({ data: { organizationId: ctx.orgId, key, nameAr: input.nameAr, nameEn: input.nameEn, baseRole: input.baseRole, permissions } });
    await audit(tx, ctx, { action: "role.create", entityType: "ROLE", entityId: role.id, after: { key, permissions } });
    return role;
  });
}

// ── Clients, contacts, venues ───────────────────────────────────────────────

export async function listClients(ctx: ServiceContext) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx.client.findMany({ include: { contacts: true, _count: { select: { projects: true } } }, orderBy: { name: "asc" } }),
  );
}

export async function saveClient(ctx: ServiceContext, input: z.output<typeof clientSchema> & { id?: string }) {
  assertCan(ctx, "org.directory.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { id, ...data } = input;
    const client = id ? await tx.client.update({ where: { id }, data }) : await tx.client.create({ data: { ...data, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: id ? "client.update" : "client.create", entityType: "CLIENT", entityId: client.id, summary: client.name });
    return client;
  });
}

export async function saveContact(ctx: ServiceContext, input: z.output<typeof contactSchema> & { id?: string }) {
  if (!can(ctx, "org.directory.manage") && !can(ctx, "vendor.manage")) throw new ForbiddenError();
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    if (input.clientId && !(await tx.client.findUnique({ where: { id: input.clientId } }))) throw new NotFoundError();
    if (input.vendorId && !(await tx.vendor.findUnique({ where: { id: input.vendorId } }))) throw new NotFoundError();
    const { id, ...data } = input;
    const payload = { ...data, email: data.email || null };
    const contact = id ? await tx.contact.update({ where: { id }, data: payload }) : await tx.contact.create({ data: { ...payload, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: id ? "contact.update" : "contact.create", entityType: "CONTACT", entityId: contact.id });
    return contact;
  });
}

export async function listVenues(ctx: ServiceContext) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => tx.venue.findMany({ include: { _count: { select: { projects: true } } }, orderBy: [{ city: "asc" }, { name: "asc" }] }));
}

export async function saveVenue(ctx: ServiceContext, input: z.output<typeof venueSchema> & { id?: string }) {
  assertCan(ctx, "org.directory.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { id, ...data } = input;
    const payload = { ...data, mapsUrl: data.mapsUrl || null };
    const venue = id ? await tx.venue.update({ where: { id }, data: payload }) : await tx.venue.create({ data: { ...payload, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: id ? "venue.update" : "venue.create", entityType: "VENUE", entityId: venue.id, summary: venue.name });
    return venue;
  });
}

// ── Teams ───────────────────────────────────────────────────────────────────

export async function listTeams(ctx: ServiceContext) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => tx.team.findMany({ include: { members: true }, orderBy: { name: "asc" } }));
}

export async function saveTeam(ctx: ServiceContext, input: z.output<typeof teamSchema> & { id?: string }) {
  assertCan(ctx, "org.members.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { id, memberIds, ...data } = input;
    const team = id ? await tx.team.update({ where: { id }, data }) : await tx.team.create({ data: { ...data, organizationId: ctx.orgId } });
    const valid = await tx.membership.findMany({ where: { userId: { in: memberIds }, status: "ACTIVE" }, select: { userId: true } });
    await tx.teamMember.deleteMany({ where: { teamId: team.id } });
    if (valid.length) await tx.teamMember.createMany({ data: valid.map((v) => ({ organizationId: ctx.orgId, teamId: team.id, userId: v.userId })) });
    await audit(tx, ctx, { action: id ? "team.update" : "team.create", entityType: "TEAM", entityId: team.id, summary: team.name });
    return team;
  });
}

// ── Custom fields ───────────────────────────────────────────────────────────

export async function listCustomFields(ctx: ServiceContext, entityType?: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx.customFieldDefinition.findMany({ where: { archived: false, ...(entityType ? { entityType } : {}) }, orderBy: [{ entityType: "asc" }, { sortOrder: "asc" }] }),
  );
}

export async function saveCustomField(ctx: ServiceContext, input: z.output<typeof customFieldSchema>) {
  assertCan(ctx, "org.customFields.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const exists = await tx.customFieldDefinition.findFirst({ where: { entityType: input.entityType, projectId: null, key: input.key } });
    if (exists) throw new ConflictError();
    const def = await tx.customFieldDefinition.create({ data: { ...input, options: input.options, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: "customField.create", entityType: "CUSTOM_FIELD", entityId: def.id, summary: `${input.entityType}.${input.key}` });
    return def;
  });
}

export async function archiveCustomField(ctx: ServiceContext, id: string) {
  assertCan(ctx, "org.customFields.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    await tx.customFieldDefinition.update({ where: { id }, data: { archived: true } });
    await audit(tx, ctx, { action: "customField.archive", entityType: "CUSTOM_FIELD", entityId: id });
  });
}

// ── Audit log ───────────────────────────────────────────────────────────────

export async function listAudit(ctx: ServiceContext, filter: { entityType?: string; action?: string; projectId?: string; cursor?: string; take?: number }) {
  assertCan(ctx, "org.audit.view");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx.auditEvent.findMany({
      where: {
        ...(filter.entityType ? { entityType: filter.entityType } : {}),
        ...(filter.action ? { action: { startsWith: filter.action } } : {}),
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(filter.take ?? 100, 500),
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    }),
  );
}
