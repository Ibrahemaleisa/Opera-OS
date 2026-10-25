import { z } from "zod";
import type { Prisma, Project } from "@/generated/prisma/client";
import type { Tx } from "@/server/db/tenant";

/**
 * The organisation's approval policy (BUSINESS_RULES §4), kept in `Organization.settings` under
 * Stream L's keys: `approvalPolicy`, `approvalException` and `approvalSlaHours`.
 */
export const APPROVAL_POLICIES = ["STANDARD", "STRICT"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/** Types the small-organisation exception may cover (§4.3). CLIENT approvals are never in scope. */
export const EXCEPTION_TYPES = ["PURCHASE_ORDER", "EXPENSE", "CHANGE_ORDER", "CAMPAIGN", "TASK", "DELIVERABLE", "MILESTONE", "DESIGN_REVISION"] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

/**
 * The exception's limits and defaults (§4.3). Turning it on is one toggle: every type, the spend cap at
 * its hard maximum, the audience cap at 500 and no expiry; the advanced options narrow these. The
 * decision itself needs a one-line note.
 */
export const EXCEPTION_LIMITS = { maxSpendCap: 250_000, defaultSpendCap: 250_000, defaultAudienceCap: 500, maxAudienceCap: 500, decisionNote: 3 } as const;

export const SLA_HOURS = { default: 48, min: 4, max: 168 } as const;

export const exceptionSettingsSchema = z.object({
  enabled: z.boolean(),
  justification: z.string().default(""),
  types: z.array(z.enum(EXCEPTION_TYPES)),
  spendCap: z.number(),
  audienceCap: z.number(),
  /** optional: no expiry by default */
  expiresAt: z.string().nullish(),
  enabledById: z.string(),
  enabledByName: z.string().nullish(),
  enabledAt: z.string(),
  disabledAt: z.string().nullish(),
  disabledById: z.string().nullish(),
});
export type ExceptionSettings = z.infer<typeof exceptionSettingsSchema>;

export interface ApprovalSettings {
  policy: ApprovalPolicy;
  exception: ExceptionSettings | null;
  slaHours: number;
}

export function parseApprovalSettings(settings: unknown): ApprovalSettings {
  const s = (settings ?? {}) as Record<string, unknown>;
  const policy = s.approvalPolicy === "STRICT" ? "STRICT" : "STANDARD";
  const parsed = exceptionSettingsSchema.safeParse(s.approvalException);
  const sla = Number(s.approvalSlaHours);
  const slaHours = Number.isFinite(sla) && sla >= SLA_HOURS.min && sla <= SLA_HOURS.max ? Math.round(sla) : SLA_HOURS.default;
  return { policy, exception: parsed.success ? parsed.data : null, slaHours };
}

export async function loadApprovalSettings(tx: Tx, orgId: string): Promise<ApprovalSettings> {
  const org = await tx.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  return parseApprovalSettings(org?.settings);
}

/** The exception is usable now: switched on and, when an expiry was set, not past it. */
export function exceptionActive(ex: ExceptionSettings | null, now = new Date()): ex is ExceptionSettings {
  return !!ex && ex.enabled && (!ex.expiresAt || new Date(ex.expiresAt).getTime() > now.getTime());
}

/** Read-merge-write of one of Stream L's settings keys, inside the caller's transaction. */
export async function writeSettingsKey(tx: Tx, orgId: string, key: "approvalPolicy" | "approvalException" | "approvalSlaHours", value: unknown) {
  // lock the row so two concurrent settings writes can't drop each other's keys
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${orgId} FOR UPDATE`;
  const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
  const merged = { ...((org.settings ?? {}) as Record<string, unknown>), [key]: value };
  await tx.organization.update({ where: { id: orgId }, data: { settings: merged as Prisma.InputJsonValue } });
}

/** STRICT applies when the organisation chose it, or to a project flagged for independent approval (AP rule 6). */
export function strictFor(settings: ApprovalSettings, project: Pick<Project, "independentApprovalRequired">) {
  return settings.policy === "STRICT" || project.independentApprovalRequired;
}

/**
 * The performers of an entity under STRICT (§4.2), evaluated at decision time. Spend is already
 * strict through the creator rule, so it has no performers here.
 */
export async function performersOf(tx: Tx, entityType: string, entityId: string): Promise<string[]> {
  const out = new Set<string>();
  const add = (...ids: (string | null | undefined)[]) => ids.forEach((id) => id && out.add(id));
  switch (entityType) {
    case "TASK": {
      const t = await tx.task.findUnique({ where: { id: entityId }, select: { ownerId: true, collaborators: { select: { userId: true } } } });
      add(t?.ownerId, ...(t?.collaborators.map((c) => c.userId) ?? []));
      break;
    }
    case "DELIVERABLE": {
      const files = await tx.attachment.findMany({ where: { entityType: "DELIVERABLE", entityId, deletedAt: null }, select: { uploadedById: true } });
      add(...files.map((f) => f.uploadedById));
      const moved = await tx.auditEvent.findFirst({ where: { entityType: "DELIVERABLE", entityId, after: { path: ["status"], equals: "SUBMITTED" } }, orderBy: { createdAt: "desc" }, select: { actorId: true } });
      add(moved?.actorId);
      break;
    }
    case "MILESTONE": {
      const m = await tx.milestone.findUnique({ where: { id: entityId }, select: { workstreamId: true, projectId: true } });
      if (m?.workstreamId) {
        const owners = await tx.task.findMany({ where: { projectId: m.projectId, workstreamId: m.workstreamId, statusCategory: { not: "CANCELLED" }, ownerId: { not: null } }, select: { ownerId: true }, distinct: ["ownerId"] });
        add(...owners.map((o) => o.ownerId));
      }
      break;
    }
    case "CAMPAIGN": {
      const c = await tx.invitationCampaign.findUnique({ where: { id: entityId }, select: { createdById: true } });
      add(c?.createdById);
      const last = await tx.approval.findFirst({ where: { entityType: "CAMPAIGN", entityId, status: { in: ["APPROVED", "SUPERSEDED"] } }, orderBy: { decidedAt: "desc" }, select: { decidedAt: true } });
      const edits = await tx.auditEvent.findMany({
        where: { entityType: "CAMPAIGN", entityId, action: { in: ["campaign.update", "campaign.audience_add", "campaign.audience_remove", "campaign.audience"] }, ...(last?.decidedAt ? { createdAt: { gt: last.decidedAt } } : {}) },
        select: { actorId: true },
      });
      add(...edits.map((e) => e.actorId));
      break;
    }
    case "DESIGN_REVISION": {
      const r = await tx.designRevision.findUnique({ where: { id: entityId }, select: { createdById: true, attachmentId: true } });
      add(r?.createdById);
      const files = await tx.attachment.findMany({
        where: { deletedAt: null, OR: [{ entityType: { in: ["REVISION", "DESIGN_REVISION"] }, entityId }, ...(r?.attachmentId ? [{ id: r.attachmentId }] : [])] },
        select: { uploadedById: true },
      });
      add(...files.map((f) => f.uploadedById));
      break;
    }
  }
  return [...out];
}

/** What a decision must respect beyond the M1 rule: performers excluded when STRICT applies. */
export interface DecidePolicy {
  strict: boolean;
  performers: string[];
}

export async function decidePolicyFor(tx: Tx, settings: ApprovalSettings, project: Pick<Project, "independentApprovalRequired">, a: { entityType: string; entityId: string }): Promise<DecidePolicy> {
  const strict = strictFor(settings, project);
  return { strict, performers: strict ? await performersOf(tx, a.entityType, a.entityId) : [] };
}
