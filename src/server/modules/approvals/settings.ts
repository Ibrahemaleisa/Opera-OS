import { z } from "zod";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { notify } from "@/server/modules/notifications/notify";
import { APPROVAL_POLICIES, EXCEPTION_LIMITS, EXCEPTION_TYPES, exceptionActive, loadApprovalSettings, SLA_HOURS, writeSettingsKey, type ExceptionSettings } from "./policy";

/** Owner-only settings (§4.2, §4.3): directors are refused (AP-10). */
function assertOwner(ctx: ServiceContext) {
  if (ctx.role !== "OWNER" || ctx.roleKey === "system") throw new ForbiddenError("errors.ownerOnly");
}

export const policyInput = z.object({ policy: z.enum(APPROVAL_POLICIES) });
export const slaInput = z.object({ hours: z.coerce.number().int().min(SLA_HOURS.min).max(SLA_HOURS.max) });
/**
 * The exception setting (§4.3): "enable" is the one toggle (defaults: every type, the hard spend cap,
 * audience 500, no expiry); "update" changes the advanced options while it is on; "disable" stops it.
 */
export const exceptionInput = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["enable", "update"]),
    justification: z.string().trim().max(2000).optional(),
    expiresAt: z.coerce.date().nullish(),
    types: z.array(z.enum(EXCEPTION_TYPES)).min(1).optional(),
    spendCap: z.coerce.number().min(0).max(EXCEPTION_LIMITS.maxSpendCap).optional(),
    audienceCap: z.coerce.number().int().min(0).max(EXCEPTION_LIMITS.maxAudienceCap).optional(),
  }),
  z.object({ action: z.literal("disable") }),
]);

export async function setApprovalPolicy(ctx: ServiceContext, input: z.output<typeof policyInput>) {
  assertOwner(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const before = await loadApprovalSettings(tx, ctx.orgId);
    if (before.policy === input.policy) return { policy: input.policy };
    await writeSettingsKey(tx, ctx.orgId, "approvalPolicy", input.policy);
    await audit(tx, ctx, { action: "org.approval_policy", entityType: "ORGANIZATION", entityId: ctx.orgId, before: { approvalPolicy: before.policy }, after: { approvalPolicy: input.policy } });
    return { policy: input.policy };
  });
}

/** The approval SLA that sets a request's default due date (§3.4, 4–168 h). */
export async function setApprovalSla(ctx: ServiceContext, input: z.output<typeof slaInput>) {
  assertCan(ctx, "org.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const before = await loadApprovalSettings(tx, ctx.orgId);
    if (before.slaHours === input.hours) return { hours: input.hours };
    await writeSettingsKey(tx, ctx.orgId, "approvalSlaHours", input.hours);
    await audit(tx, ctx, { action: "org.approval_sla", entityType: "ORGANIZATION", entityId: ctx.orgId, before: { approvalSlaHours: before.slaHours }, after: { approvalSlaHours: input.hours } });
    return { hours: input.hours };
  });
}

/**
 * Turn the small-organisation exception on (one toggle, sensible defaults), adjust its advanced
 * options, or turn it off (§4.3). Owner only. Every change is audited and told to the other owners.
 */
export async function setApprovalException(ctx: ServiceContext, input: z.output<typeof exceptionInput>) {
  assertOwner(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const before = await loadApprovalSettings(tx, ctx.orgId);
    const now = new Date();
    if (input.action === "disable") {
      if (!before.exception?.enabled) return { enabled: false };
      const next: ExceptionSettings = { ...before.exception, enabled: false, disabledAt: now.toISOString(), disabledById: ctx.userId };
      await writeSettingsKey(tx, ctx.orgId, "approvalException", next);
      await audit(tx, ctx, { action: "org.approval_exception_disabled", entityType: "ORGANIZATION", entityId: ctx.orgId, before: { enabled: true }, after: { enabled: false } });
      return { enabled: false };
    }
    // an expiry is optional; when given it must lie ahead
    if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) throw new ValidationError("errors.validation", { expiresAt: ["errors.validation"] });
    const wasOn = exceptionActive(before.exception, now);
    const prev = wasOn ? before.exception : null;
    const next: ExceptionSettings = {
      enabled: true,
      justification: input.justification ?? prev?.justification ?? "",
      types: input.types ?? prev?.types ?? [...EXCEPTION_TYPES],
      spendCap: input.spendCap ?? prev?.spendCap ?? EXCEPTION_LIMITS.defaultSpendCap,
      audienceCap: input.audienceCap ?? prev?.audienceCap ?? EXCEPTION_LIMITS.defaultAudienceCap,
      expiresAt: input.expiresAt === undefined ? prev?.expiresAt ?? null : input.expiresAt?.toISOString() ?? null,
      enabledById: prev?.enabledById ?? ctx.userId,
      enabledByName: prev?.enabledByName ?? ctx.userName,
      enabledAt: prev?.enabledAt ?? now.toISOString(),
      disabledAt: null,
      disabledById: null,
    };
    await writeSettingsKey(tx, ctx.orgId, "approvalException", next);
    await audit(tx, ctx, {
      action: wasOn ? "org.approval_exception_updated" : "org.approval_exception_enabled", entityType: "ORGANIZATION", entityId: ctx.orgId, summary: next.justification.slice(0, 500) || undefined,
      after: { justification: next.justification, types: next.types, spendCap: next.spendCap, audienceCap: next.audienceCap, expiresAt: next.expiresAt },
    });
    if (!wasOn) {
      const owners = await tx.membership.findMany({ where: { organizationId: ctx.orgId, status: "ACTIVE", role: { baseRole: "OWNER" }, userId: { not: ctx.userId } }, select: { userId: true } });
      await notify(tx, { orgId: ctx.orgId, userIds: owners.map((o) => o.userId), type: "approval.exception_enabled", titleKey: "tasks.policy.notices.exceptionEnabled", params: { name: ctx.userName }, link: "/settings", mandatory: true });
    }
    return { enabled: true };
  });
}

/** What the settings page shows: the policy, the SLA, the exception and this month's self-approvals. */
export async function getApprovalSettingsView(ctx: ServiceContext) {
  assertCan(ctx, "org.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const s = await loadApprovalSettings(tx, ctx.orgId);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const uses = await tx.auditEvent.findMany({ where: { action: "approval.self_approved", createdAt: { gte: monthStart } }, select: { meta: true } });
    const amount = uses.reduce((n, u) => n + Number((u.meta as { amount?: number } | null)?.amount ?? 0), 0);
    return {
      policy: s.policy,
      slaHours: s.slaHours,
      exception: s.exception,
      exceptionActive: exceptionActive(s.exception),
      month: { count: uses.length, amount },
      isOwner: ctx.role === "OWNER",
      limits: EXCEPTION_LIMITS,
    };
  });
}
