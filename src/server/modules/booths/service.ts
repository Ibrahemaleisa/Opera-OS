import { z } from "zod";
import type { Booth, BoothStage } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan, can, projectScope, projectVisibilityWhere, type ProjectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { requestApprovalTx } from "@/server/modules/approvals/service";

export const STAGES: BoothStage[] = ["BRIEF", "DESIGN", "CLIENT_APPROVAL", "PROCUREMENT", "FABRICATION", "LOGISTICS", "INSTALLATION", "INSPECTION", "HANDOVER", "LIVE", "DISMANTLING", "CLOSED"];
export const BOQ_CATEGORIES = ["STRUCTURE", "FINISHES", "AV", "LIGHTING", "GRAPHICS", "FURNITURE", "FABRICATION", "LOGISTICS"] as const;
export const BOQ_STATUSES = ["PLANNED", "RFQ", "ORDERED", "IN_PRODUCTION", "DELIVERED", "INSTALLED"] as const;
export const INSPECTION_TYPES = ["STRUCTURAL", "ELECTRICAL", "FINISH", "SAFETY", "CLIENT_WALKTHROUGH"] as const;
/** Inspections that must have a latest result of PASS before handover. */
export const REQUIRED_INSPECTIONS = ["STRUCTURAL", "ELECTRICAL", "SAFETY"] as const;

const optText = (max = 500) => z.string().trim().max(max).nullish();
const optDate = z.coerce.date().nullish();
const money = z.coerce.number().min(0).max(1e11);

export const boothSchema = z.object({
  id: z.string().optional(),
  projectId: z.string(),
  name: z.string().trim().min(2).max(200),
  kind: z.enum(["BOOTH", "PAVILION"]).default("BOOTH"),
  exhibition: optText(200),
  hall: optText(50),
  standNumber: optText(50),
  widthM: z.coerce.number().min(0).max(1000).nullish(),
  depthM: z.coerce.number().min(0).max(1000).nullish(),
  heightM: z.coerce.number().min(0).max(100).nullish(),
  brief: optText(5000),
  permitStatus: z.enum(["NOT_STARTED", "SUBMITTED", "APPROVED", "REJECTED"]).default("NOT_STARTED"),
  siteAccessAt: optDate,
  buildStartAt: optDate,
  handoverAt: optDate,
  dismantleAt: optDate,
});

export const boqSchema = z.object({
  id: z.string().optional(),
  boothId: z.string(),
  code: z.string().trim().min(1).max(30),
  description: z.string().trim().min(2).max(500),
  category: z.enum(BOQ_CATEGORIES).default("FABRICATION"),
  unit: z.string().trim().min(1).max(20).default("unit"),
  quantity: z.coerce.number().min(0).max(1e9),
  unitCost: money,
  committedCost: money.default(0),
  actualCost: money.default(0),
  vendorId: z.string().nullish(),
  status: z.enum(BOQ_STATUSES).default("PLANNED"),
});

export const inspectionSchema = z.object({ boothId: z.string(), type: z.enum(INSPECTION_TYPES), result: z.enum(["PASS", "FAIL", "CONDITIONAL"]), notes: optText(2000) });
export const snagSchema = z.object({ id: z.string().optional(), boothId: z.string(), title: z.string().trim().min(2).max(200), location: optText(100), severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"), assigneeId: z.string().nullish() });

const scoped = (ctx: ServiceContext) => ({ orgId: ctx.orgId, userId: ctx.userId });

async function loadBooth(tx: Tx, ctx: ServiceContext, boothId: string): Promise<{ booth: Booth; scope: ProjectScope }> {
  const booth = await tx.booth.findUnique({ where: { id: boothId } });
  if (!booth) throw new NotFoundError();
  const scope = await projectScope(tx, ctx, booth.projectId);
  if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
  return { booth, scope };
}

async function editableBooth(tx: Tx, ctx: ServiceContext, boothId: string) {
  assertCan(ctx, "booth.manage");
  const r = await loadBooth(tx, ctx, boothId);
  if (!r.scope.operate) throw new ForbiddenError();
  return r;
}

function assertDateOrder(b: { siteAccessAt?: Date | null; buildStartAt?: Date | null; handoverAt?: Date | null; dismantleAt?: Date | null }) {
  const seq: [string, Date | null | undefined][] = [["siteAccessAt", b.siteAccessAt], ["buildStartAt", b.buildStartAt], ["handoverAt", b.handoverAt], ["dismantleAt", b.dismantleAt]];
  let last: Date | null = null;
  for (const [k, d] of seq) {
    if (!d) continue;
    if (last && d < last) throw new ValidationError("errors.validation", { [k]: ["booths.dateOrder"] });
    last = d;
  }
}

/** Gate checks per target stage. Returns the list of unmet requirement keys (empty = allowed). */
async function stageGates(tx: Tx, booth: Booth, target: BoothStage): Promise<string[]> {
  const unmet: string[] = [];
  const idx = STAGES.indexOf(target);
  const at = (s: BoothStage) => idx >= STAGES.indexOf(s);
  if (at("CLIENT_APPROVAL") && !(await tx.designRevision.count({ where: { boothId: booth.id, status: { in: ["SUBMITTED", "APPROVED"] } } }))) unmet.push("booths.gate.revisionSubmitted");
  if (at("PROCUREMENT") && !(await tx.designRevision.count({ where: { boothId: booth.id, status: "APPROVED" } }))) unmet.push("booths.gate.designApproved");
  if (at("FABRICATION") && !(await tx.bOQItem.count({ where: { boothId: booth.id } }))) unmet.push("booths.gate.boq");
  if (at("INSTALLATION") && booth.permitStatus !== "APPROVED") unmet.push("booths.gate.permit");
  if (at("HANDOVER")) unmet.push(...(await handoverReadiness(tx, booth)).filter((c) => !c.ok).map((c) => c.key));
  if (at("LIVE") && !booth.handoverSignedAt) unmet.push("booths.gate.handoverSigned");
  return [...new Set(unmet)];
}

export async function handoverReadiness(tx: Tx, booth: Booth) {
  const [approvedRevision, inspections, blockingSnags] = await Promise.all([
    tx.designRevision.count({ where: { boothId: booth.id, status: "APPROVED" } }),
    tx.inspection.findMany({ where: { boothId: booth.id }, orderBy: { inspectedAt: "desc" } }),
    tx.snag.count({ where: { boothId: booth.id, status: { in: ["OPEN", "IN_PROGRESS"] }, severity: { in: ["HIGH", "CRITICAL"] } } }),
  ]);
  const latest = (type: string) => inspections.find((i) => i.type === type)?.result;
  return [
    { key: "booths.gate.designApproved", ok: approvedRevision > 0 },
    { key: "booths.gate.permit", ok: booth.permitStatus === "APPROVED" },
    ...REQUIRED_INSPECTIONS.map((t) => ({ key: `booths.gate.inspection.${t}`, ok: latest(t) === "PASS" })),
    { key: "booths.gate.noBlockingSnags", ok: blockingSnags === 0 },
  ];
}

// ── Queries ─────────────────────────────────────────────────────────────────

export async function listBooths(ctx: ServiceContext, projectId?: string) {
  return withTenant(scoped(ctx), async (tx) => {
    let projectIds: string[];
    if (projectId) {
      const s = await projectScope(tx, ctx, projectId);
      if (s.clientView || s.fieldOnly) throw new NotFoundError();
      projectIds = [projectId];
    } else {
      projectIds = (await tx.project.findMany({ where: { ...projectVisibilityWhere(ctx), archivedAt: null }, select: { id: true } })).map((p) => p.id);
    }
    const booths = await tx.booth.findMany({ where: { projectId: { in: projectIds } }, orderBy: [{ handoverAt: "asc" }, { name: "asc" }] });
    const ids = booths.map((b) => b.id);
    const [projects, snags, boq] = await Promise.all([
      tx.project.findMany({ where: { id: { in: [...new Set(booths.map((b) => b.projectId))] } }, select: { id: true, code: true, name: true } }),
      tx.snag.groupBy({ by: ["boothId"], where: { boothId: { in: ids }, status: { in: ["OPEN", "IN_PROGRESS"] } }, _count: true }),
      tx.bOQItem.findMany({ where: { boothId: { in: ids } }, select: { boothId: true, quantity: true, unitCost: true, actualCost: true } }),
    ]);
    return {
      canManage: can(ctx, "booth.manage"),
      booths: booths.map((b) => {
        const items = boq.filter((x) => x.boothId === b.id);
        return {
          ...b,
          project: projects.find((p) => p.id === b.projectId)!,
          openSnags: snags.find((s) => s.boothId === b.id)?._count ?? 0,
          estimate: items.reduce((a, x) => a + Number(x.quantity) * Number(x.unitCost), 0),
          actual: items.reduce((a, x) => a + Number(x.actualCost), 0),
          stageIndex: STAGES.indexOf(b.stage),
        };
      }),
    };
  });
}

export async function getBooth(ctx: ServiceContext, boothId: string) {
  return withTenant(scoped(ctx), async (tx) => {
    const { booth, scope } = await loadBooth(tx, ctx, boothId);
    const [revisions, boq, inspections, snags, vendors, members, readiness, nextGates] = await Promise.all([
      tx.designRevision.findMany({ where: { boothId }, orderBy: { revisionNo: "desc" } }),
      tx.bOQItem.findMany({ where: { boothId }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] }),
      tx.inspection.findMany({ where: { boothId }, orderBy: { inspectedAt: "desc" } }),
      tx.snag.findMany({ where: { boothId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] }),
      tx.vendor.findMany({ where: { status: { not: "BLACKLISTED" } }, select: { id: true, name: true, category: true }, orderBy: { name: "asc" } }),
      tx.membership.findMany({ where: { status: "ACTIVE", role: { baseRole: { notIn: ["CLIENT", "CLIENT_APPROVER"] } } }, include: { user: { select: { id: true, name: true, nameAr: true } } } }),
      handoverReadiness(tx, booth),
      STAGES.indexOf(booth.stage) < STAGES.length - 1 ? stageGates(tx, booth, STAGES[STAGES.indexOf(booth.stage) + 1]) : Promise.resolve([]),
    ]);
    const attachments = await tx.attachment.findMany({ where: { entityType: { in: ["BOOTH", "REVISION"] }, entityId: { in: [booth.id, ...revisions.map((r) => r.id)] }, deletedAt: null }, orderBy: { createdAt: "desc" } });
    const approvals = await tx.approval.findMany({ where: { entityType: "DESIGN_REVISION", entityId: { in: revisions.map((r) => r.id) } }, orderBy: { createdAt: "desc" } });
    const num = (d: unknown) => Number(d ?? 0);
    const totals = boq.reduce((a, x) => ({ estimate: a.estimate + num(x.quantity) * num(x.unitCost), committed: a.committed + num(x.committedCost), actual: a.actual + num(x.actualCost) }), { estimate: 0, committed: 0, actual: 0 });
    return {
      booth,
      project: { id: scope.project.id, code: scope.project.code, name: scope.project.name, currency: scope.project.currency },
      canManage: can(ctx, "booth.manage") && scope.operate,
      showCosts: scope.finance || can(ctx, "booth.manage"),
      revisions: revisions.map((r) => ({ ...r, attachments: attachments.filter((a) => a.entityType === "REVISION" && a.entityId === r.id), approval: approvals.find((a) => a.entityId === r.id) ?? null })),
      boothFiles: attachments.filter((a) => a.entityType === "BOOTH"),
      boq: boq.map((x) => ({ ...x, quantity: num(x.quantity), unitCost: num(x.unitCost), committedCost: num(x.committedCost), actualCost: num(x.actualCost), total: num(x.quantity) * num(x.unitCost) })),
      totals,
      inspections,
      snags,
      vendors,
      people: members.map((m) => ({ id: m.user.id, name: (ctx.locale === "ar" ? m.user.nameAr : null) ?? m.user.name })),
      readiness,
      nextStage: STAGES[STAGES.indexOf(booth.stage) + 1] ?? null,
      nextGates,
    };
  });
}

// ── Mutations ───────────────────────────────────────────────────────────────

export async function saveBooth(ctx: ServiceContext, input: z.output<typeof boothSchema>) {
  assertCan(ctx, "booth.manage");
  assertDateOrder(input);
  return withTenant(scoped(ctx), async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (!scope.operate || scope.clientView) throw new ForbiddenError();
    const { id, projectId, ...data } = input;
    if (id) {
      const existing = await tx.booth.findFirst({ where: { id, projectId } });
      if (!existing) throw new NotFoundError();
      const b = await tx.booth.update({ where: { id }, data });
      await audit(tx, ctx, { action: "booth.update", entityType: "BOOTH", entityId: id, projectId, summary: b.name, before: { permitStatus: existing.permitStatus }, after: { permitStatus: b.permitStatus } });
      return b;
    }
    const ws = await tx.workstream.findFirst({ where: { projectId, kind: data.kind === "PAVILION" ? "PAVILION" : "BOOTH" } });
    const b = await tx.booth.create({ data: { ...data, organizationId: ctx.orgId, projectId, workstreamId: ws?.id ?? null } });
    await audit(tx, ctx, { action: "booth.create", entityType: "BOOTH", entityId: b.id, projectId, summary: b.name });
    return b;
  });
}

/**
 * Moves a booth through production. Forward moves must pass every gate up to the target;
 * moving backwards is allowed (e.g. a failed inspection sends work back) and is audited with a reason.
 */
export async function setBoothStage(ctx: ServiceContext, input: { boothId: string; stage: BoothStage; reason?: string | null }) {
  return withTenant(scoped(ctx), async (tx) => {
    const { booth } = await editableBooth(tx, ctx, input.boothId);
    const from = STAGES.indexOf(booth.stage);
    const to = STAGES.indexOf(input.stage);
    if (to === from) return booth;
    if (to > from) {
      const unmet = await stageGates(tx, booth, input.stage);
      if (unmet.length) throw new ValidationError("booths.gateBlocked", { stage: unmet });
    } else if (!input.reason?.trim()) {
      throw new ValidationError("errors.validation", { reason: ["booths.reasonRequired"] });
    }
    const r = await tx.booth.updateMany({ where: { id: booth.id, stage: booth.stage }, data: { stage: input.stage } });
    if (!r.count) throw new ConflictError();
    await audit(tx, ctx, { action: "booth.stage", entityType: "BOOTH", entityId: booth.id, projectId: booth.projectId, summary: `${booth.stage} → ${input.stage}`, meta: { reason: input.reason ?? null } });
    return tx.booth.findUniqueOrThrow({ where: { id: booth.id } });
  });
}

export async function createRevision(ctx: ServiceContext, input: { boothId: string; title: string; notes?: string | null }) {
  return withTenant(scoped(ctx), async (tx) => {
    const { booth } = await editableBooth(tx, ctx, input.boothId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rev:${booth.id}`}))`;
    const last = await tx.designRevision.findFirst({ where: { boothId: booth.id }, orderBy: { revisionNo: "desc" } });
    const rev = await tx.designRevision.create({ data: { organizationId: ctx.orgId, boothId: booth.id, revisionNo: (last?.revisionNo ?? 0) + 1, title: input.title, notes: input.notes ?? null, createdById: ctx.userId } });
    if (["BRIEF"].includes(booth.stage)) await tx.booth.update({ where: { id: booth.id }, data: { stage: "DESIGN" } });
    await audit(tx, ctx, { action: "revision.create", entityType: "DESIGN_REVISION", entityId: rev.id, projectId: booth.projectId, summary: `R${rev.revisionNo} ${rev.title}` });
    return rev;
  });
}

/** Submits a design revision for (client or internal) approval. A revision needs at least one design file. */
export async function submitRevision(ctx: ServiceContext, input: { revisionId: string; approverType: "INTERNAL" | "CLIENT"; approverUserId?: string | null }) {
  return withTenant(scoped(ctx), async (tx) => {
    const rev = await tx.designRevision.findUnique({ where: { id: input.revisionId } });
    if (!rev) throw new NotFoundError();
    const { booth } = await editableBooth(tx, ctx, rev.boothId);
    if (rev.status !== "DRAFT" && rev.status !== "REJECTED") throw new ValidationError("errors.invalidTransition");
    const files = await tx.attachment.count({ where: { entityType: "REVISION", entityId: rev.id, deletedAt: null } });
    if (!files) throw new ValidationError("booths.revisionNeedsFile");
    if (input.approverType === "CLIENT") {
      // the design files become visible to the client together with the approval request
      await tx.attachment.updateMany({ where: { entityType: "REVISION", entityId: rev.id }, data: { clientVisible: true } });
    }
    const a = await requestApprovalTx(tx, ctx, { projectId: booth.projectId, entityType: "DESIGN_REVISION", entityId: rev.id, title: `${booth.name} — R${rev.revisionNo}: ${rev.title}`, description: rev.notes, approverType: input.approverType, approverUserId: input.approverUserId ?? null, dueAt: null });
    await tx.booth.updateMany({ where: { id: booth.id, stage: { in: ["BRIEF", "DESIGN"] } }, data: { stage: "CLIENT_APPROVAL" } });
    return a;
  });
}

export async function saveBoqItem(ctx: ServiceContext, input: z.output<typeof boqSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    const { booth } = await editableBooth(tx, ctx, input.boothId);
    if (input.vendorId && !(await tx.vendor.findUnique({ where: { id: input.vendorId } }))) throw new NotFoundError();
    const { id, ...data } = input;
    const dup = await tx.bOQItem.findFirst({ where: { boothId: booth.id, code: data.code, id: id ? { not: id } : undefined } });
    if (dup) throw new ValidationError("errors.validation", { code: ["booths.boqCodeTaken"] });
    const item = id
      ? await (async () => {
          const u = await tx.bOQItem.updateMany({ where: { id, boothId: booth.id }, data });
          if (!u.count) throw new NotFoundError();
          return tx.bOQItem.findUniqueOrThrow({ where: { id } });
        })()
      : await tx.bOQItem.create({ data: { ...data, organizationId: ctx.orgId, projectId: booth.projectId, sortOrder: await tx.bOQItem.count({ where: { boothId: booth.id } }) } });
    await audit(tx, ctx, { action: id ? "boq.update" : "boq.create", entityType: "BOQ_ITEM", entityId: item.id, projectId: booth.projectId, summary: `${item.code} ${item.description}` });
    return item;
  });
}

export async function deleteBoqItem(ctx: ServiceContext, input: { id: string; boothId: string }) {
  return withTenant(scoped(ctx), async (tx) => {
    const { booth } = await editableBooth(tx, ctx, input.boothId);
    const item = await tx.bOQItem.findFirst({ where: { id: input.id, boothId: booth.id } });
    if (!item) throw new NotFoundError();
    if (Number(item.committedCost) > 0 || Number(item.actualCost) > 0) throw new ValidationError("booths.boqHasCosts");
    await tx.bOQItem.delete({ where: { id: item.id } });
    await audit(tx, ctx, { action: "boq.delete", entityType: "BOQ_ITEM", entityId: item.id, projectId: booth.projectId, summary: item.code });
    return { deleted: true };
  });
}

export async function recordInspection(ctx: ServiceContext, input: z.output<typeof inspectionSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    const { booth } = await editableBooth(tx, ctx, input.boothId);
    if (input.result !== "PASS" && !input.notes?.trim()) throw new ValidationError("errors.validation", { notes: ["booths.inspectionNotes"] });
    const i = await tx.inspection.create({ data: { ...input, organizationId: ctx.orgId, inspectedById: ctx.userId } });
    await audit(tx, ctx, { action: "inspection.record", entityType: "INSPECTION", entityId: i.id, projectId: booth.projectId, summary: `${i.type}: ${i.result}` });
    return i;
  });
}

export async function saveSnag(ctx: ServiceContext, input: z.output<typeof snagSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    const { booth } = await editableBooth(tx, ctx, input.boothId);
    const { id, ...data } = input;
    const s = id
      ? await (async () => {
          const u = await tx.snag.updateMany({ where: { id, boothId: booth.id }, data });
          if (!u.count) throw new NotFoundError();
          return tx.snag.findUniqueOrThrow({ where: { id } });
        })()
      : await tx.snag.create({ data: { ...data, organizationId: ctx.orgId, createdById: ctx.userId } });
    await audit(tx, ctx, { action: id ? "snag.update" : "snag.create", entityType: "SNAG", entityId: s.id, projectId: booth.projectId, summary: `${s.severity}: ${s.title}` });
    return s;
  });
}

const SNAG_FLOW: Record<string, string[]> = { OPEN: ["IN_PROGRESS", "FIXED"], IN_PROGRESS: ["FIXED", "OPEN"], FIXED: ["VERIFIED", "OPEN"], VERIFIED: [] };

/** Snags are verified by someone other than the person who fixed them. */
export async function setSnagStatus(ctx: ServiceContext, input: { id: string; status: "OPEN" | "IN_PROGRESS" | "FIXED" | "VERIFIED" }) {
  return withTenant(scoped(ctx), async (tx) => {
    const s = await tx.snag.findUnique({ where: { id: input.id } });
    if (!s) throw new NotFoundError();
    const { booth } = await editableBooth(tx, ctx, s.boothId);
    if (!SNAG_FLOW[s.status]?.includes(input.status)) throw new ValidationError("errors.invalidTransition");
    if (input.status === "VERIFIED") {
      const fixedBy = await tx.auditEvent.findFirst({ where: { entityType: "SNAG", entityId: s.id, action: "snag.status", summary: { endsWith: "→ FIXED" } }, orderBy: { createdAt: "desc" } });
      if (fixedBy?.actorId === ctx.userId) throw new ValidationError("booths.verifyOwnFix");
    }
    const u = await tx.snag.update({ where: { id: s.id }, data: { status: input.status, fixedAt: input.status === "FIXED" ? new Date() : input.status === "OPEN" ? null : s.fixedAt } });
    await audit(tx, ctx, { action: "snag.status", entityType: "SNAG", entityId: s.id, projectId: booth.projectId, summary: `${s.title}: ${s.status} → ${input.status}` });
    return u;
  });
}

/** Records the handover sign-off. All handover gates must be green. */
export async function signHandover(ctx: ServiceContext, input: { boothId: string; signedBy: string }) {
  return withTenant(scoped(ctx), async (tx) => {
    const { booth } = await editableBooth(tx, ctx, input.boothId);
    const unmet = (await handoverReadiness(tx, booth)).filter((c) => !c.ok).map((c) => c.key);
    if (unmet.length) throw new ValidationError("booths.gateBlocked", { stage: unmet });
    if (booth.handoverSignedAt) throw new ConflictError();
    const b = await tx.booth.update({ where: { id: booth.id }, data: { handoverSignedBy: input.signedBy, handoverSignedAt: new Date(), stage: STAGES.indexOf(booth.stage) < STAGES.indexOf("HANDOVER") ? "HANDOVER" : booth.stage } });
    await audit(tx, ctx, { action: "booth.handover", entityType: "BOOTH", entityId: booth.id, projectId: booth.projectId, summary: `${booth.name} — ${input.signedBy}` });
    return b;
  });
}
