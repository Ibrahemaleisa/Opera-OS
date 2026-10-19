import { z } from "zod";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan, can, projectScope, projectVisibilityWhere } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { BUDGET_CATEGORIES, nextFinanceCode } from "@/server/modules/finance/codes";

export const VENDOR_CATEGORIES = ["FABRICATION", "AV", "PRINTING", "CATERING", "TRANSPORT", "FLORAL", "SECURITY", "STAFFING", "VENUE", "OTHER"] as const;
export const VENDOR_STATUSES = ["ACTIVE", "PREFERRED", "ON_HOLD", "BLACKLISTED"] as const;
export const WO_STATUSES = ["ISSUED", "ACCEPTED", "IN_PROGRESS", "DELIVERED", "ACCEPTED_BY_AGENCY", "CANCELLED"] as const;

const optText = (max = 500) => z.string().trim().max(max).nullish();
const money = z.coerce.number().min(0).max(1e11);

export const vendorSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2).max(200),
  nameEn: optText(200),
  category: z.enum(VENDOR_CATEGORIES),
  crNumber: z.string().trim().regex(/^\d{10}$/, "vendors.crInvalid").nullish().or(z.literal("").transform(() => null)),
  vatNumber: z.string().trim().regex(/^3\d{13}3$/, "vendors.vatInvalid").nullish().or(z.literal("").transform(() => null)),
  email: z.string().trim().email().max(200).nullish().or(z.literal("").transform(() => null)),
  phone: optText(30),
  city: optText(100),
  status: z.enum(VENDOR_STATUSES).default("ACTIVE"),
  notes: optText(2000),
});

export const rfqSchema = z.object({ projectId: z.string(), title: z.string().trim().min(3).max(200), description: optText(4000), category: z.enum(VENDOR_CATEGORIES).nullish(), dueAt: z.coerce.date().nullish(), vendorIds: z.array(z.string()).min(1).max(20) });
export const quoteSchema = z.object({ projectId: z.string(), rfqId: z.string().nullish(), vendorId: z.string(), reference: optText(100), amount: money, vatAmount: money.default(0), validUntil: z.coerce.date().nullish(), leadTimeDays: z.coerce.number().int().min(0).max(3650).nullish(), notes: optText(2000) });
export const workOrderSchema = z.object({ projectId: z.string(), vendorId: z.string(), title: z.string().trim().min(3).max(200), scope: optText(4000), dueAt: z.coerce.date().nullish() });

const scoped = (ctx: ServiceContext) => ({ orgId: ctx.orgId, userId: ctx.userId });

async function operateProject(tx: Tx, ctx: ServiceContext, projectId: string) {
  const s = await projectScope(tx, ctx, projectId);
  if (!s.operate || s.clientView || s.fieldOnly) throw new ForbiddenError();
  return s;
}

async function activeVendor(tx: Tx, vendorId: string) {
  const v = await tx.vendor.findUnique({ where: { id: vendorId } });
  if (!v) throw new NotFoundError();
  if (v.status === "BLACKLISTED") throw new ValidationError("vendors.blacklisted");
  return v;
}

// ── Directory & performance ─────────────────────────────────────────────────

/** Vendor directory with performance computed from real work orders, quotes and purchase orders. */
export async function listVendors(ctx: ServiceContext, f: { q?: string; category?: string } = {}) {
  assertCan(ctx, "vendor.view");
  return withTenant(scoped(ctx), async (tx) => {
    const vendors = await tx.vendor.findMany({
      where: { ...(f.category ? { category: f.category } : {}), ...(f.q ? { OR: [{ name: { contains: f.q, mode: "insensitive" } }, { nameEn: { contains: f.q, mode: "insensitive" } }, { city: { contains: f.q, mode: "insensitive" } }] } : {}) },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    });
    const ids = vendors.map((v) => v.id);
    const [wos, pos, quotes] = await Promise.all([
      tx.workOrder.findMany({ where: { vendorId: { in: ids } }, select: { vendorId: true, status: true, rating: true, onTime: true } }),
      can(ctx, "finance.view") ? tx.purchaseOrder.groupBy({ by: ["vendorId"], where: { vendorId: { in: ids }, status: { notIn: ["DRAFT", "CANCELLED"] } }, _sum: { amount: true }, _count: true }) : Promise.resolve([]),
      tx.quote.groupBy({ by: ["vendorId", "status"], where: { vendorId: { in: ids } }, _count: true }),
    ]);
    return {
      canManage: can(ctx, "vendor.manage"),
      showSpend: can(ctx, "finance.view"),
      vendors: vendors.map((v) => {
        const w = wos.filter((x) => x.vendorId === v.id);
        const done = w.filter((x) => x.status === "ACCEPTED_BY_AGENCY");
        const rated = done.filter((x) => x.rating);
        const timed = done.filter((x) => x.onTime !== null);
        const q = quotes.filter((x) => x.vendorId === v.id);
        const po = pos.find((x) => x.vendorId === v.id);
        return {
          ...v,
          perf: {
            workOrders: w.length,
            active: w.filter((x) => ["ISSUED", "ACCEPTED", "IN_PROGRESS", "DELIVERED"].includes(x.status)).length,
            completed: done.length,
            avgRating: rated.length ? rated.reduce((a, x) => a + (x.rating ?? 0), 0) / rated.length : null,
            onTimeRate: timed.length ? timed.filter((x) => x.onTime).length / timed.length : null,
            quotes: q.reduce((a, x) => a + x._count, 0),
            winRate: q.length ? (q.find((x) => x.status === "ACCEPTED")?._count ?? 0) / q.reduce((a, x) => a + x._count, 0) : null,
            spend: po ? Number(po._sum.amount ?? 0) : null,
          },
        };
      }),
    };
  });
}

export async function saveVendor(ctx: ServiceContext, input: z.output<typeof vendorSchema>) {
  assertCan(ctx, "vendor.manage");
  return withTenant(scoped(ctx), async (tx) => {
    const { id, ...data } = input;
    if (id) {
      const before = await tx.vendor.findUnique({ where: { id } });
      if (!before) throw new NotFoundError();
      const v = await tx.vendor.update({ where: { id }, data });
      await audit(tx, ctx, { action: "vendor.update", entityType: "VENDOR", entityId: id, summary: v.name, before: { status: before.status }, after: { status: v.status } });
      return v;
    }
    const v = await tx.vendor.create({ data: { ...data, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: "vendor.create", entityType: "VENDOR", entityId: v.id, summary: v.name });
    return v;
  });
}

// ── RFQs & quotes ───────────────────────────────────────────────────────────

export async function listProcurement(ctx: ServiceContext, projectId: string) {
  assertCan(ctx, "vendor.view");
  return withTenant(scoped(ctx), async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
    const [rfqs, quotes, workOrders, vendors] = await Promise.all([
      tx.rFQ.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } }),
      tx.quote.findMany({ where: { projectId }, orderBy: [{ amount: "asc" }] }),
      tx.workOrder.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } }),
      tx.vendor.findMany({ select: { id: true, name: true, category: true, status: true }, orderBy: { name: "asc" } }),
    ]);
    const showAmounts = scope.finance || can(ctx, "vendor.manage");
    return {
      canManage: can(ctx, "vendor.manage") && scope.operate,
      canFinance: can(ctx, "finance.manage") && scope.finance,
      showAmounts,
      rfqs: rfqs.map((r) => ({ ...r, quotes: quotes.filter((q) => q.rfqId === r.id).map((q) => ({ ...q, amount: showAmounts ? Number(q.amount) : null, vatAmount: showAmounts ? Number(q.vatAmount) : null })) })),
      looseQuotes: quotes.filter((q) => !q.rfqId).map((q) => ({ ...q, amount: showAmounts ? Number(q.amount) : null, vatAmount: showAmounts ? Number(q.vatAmount) : null })),
      workOrders,
      vendors,
    };
  });
}

export async function createRfq(ctx: ServiceContext, input: z.output<typeof rfqSchema>) {
  assertCan(ctx, "vendor.manage");
  return withTenant(scoped(ctx), async (tx) => {
    await operateProject(tx, ctx, input.projectId);
    for (const v of new Set(input.vendorIds)) await activeVendor(tx, v);
    const code = await nextFinanceCode(tx, ctx.orgId, "RFQ");
    const r = await tx.rFQ.create({ data: { ...input, vendorIds: [...new Set(input.vendorIds)], code, organizationId: ctx.orgId, createdById: ctx.userId } });
    // one REQUESTED quote placeholder per invited vendor, so the comparison shows who hasn't answered
    await tx.quote.createMany({ data: r.vendorIds.map((vendorId) => ({ organizationId: ctx.orgId, projectId: r.projectId, rfqId: r.id, vendorId, amount: 0, status: "REQUESTED" as const })) });
    await audit(tx, ctx, { action: "rfq.create", entityType: "RFQ", entityId: r.id, projectId: r.projectId, summary: `${r.code} ${r.title} (${r.vendorIds.length})` });
    return r;
  });
}

/** Records a vendor quote. For an RFQ, it fills that vendor's REQUESTED placeholder. */
export async function recordQuote(ctx: ServiceContext, input: z.output<typeof quoteSchema>) {
  assertCan(ctx, "vendor.manage");
  return withTenant(scoped(ctx), async (tx) => {
    await operateProject(tx, ctx, input.projectId);
    await activeVendor(tx, input.vendorId);
    if (input.validUntil && input.validUntil < new Date()) throw new ValidationError("errors.validation", { validUntil: ["vendors.quoteExpired"] });
    if (input.rfqId) {
      const rfq = await tx.rFQ.findFirst({ where: { id: input.rfqId, projectId: input.projectId } });
      if (!rfq) throw new NotFoundError();
      if (rfq.status !== "OPEN") throw new ValidationError("errors.invalidTransition");
      if (!rfq.vendorIds.includes(input.vendorId)) throw new ValidationError("vendors.notInvited");
      const placeholder = await tx.quote.findFirst({ where: { rfqId: rfq.id, vendorId: input.vendorId, status: "REQUESTED" } });
      if (placeholder) {
        const q = await tx.quote.update({ where: { id: placeholder.id }, data: { ...input, status: "RECEIVED" } });
        await audit(tx, ctx, { action: "quote.record", entityType: "QUOTE", entityId: q.id, projectId: q.projectId, summary: `${rfq.code}` });
        return q;
      }
    }
    const q = await tx.quote.create({ data: { ...input, organizationId: ctx.orgId, status: "RECEIVED" } });
    await audit(tx, ctx, { action: "quote.record", entityType: "QUOTE", entityId: q.id, projectId: q.projectId });
    return q;
  });
}

/**
 * Awards a quote: it becomes ACCEPTED, competing quotes on the RFQ are REJECTED, the RFQ is AWARDED,
 * and a DRAFT purchase order is prepared from it (which still goes through PO approval rules).
 */
export async function awardQuote(ctx: ServiceContext, input: { quoteId: string; budgetCategory: (typeof BUDGET_CATEGORIES)[number]; justification?: string | null }) {
  assertCan(ctx, "vendor.manage");
  return withTenant(scoped(ctx), async (tx) => {
    const q = await tx.quote.findUnique({ where: { id: input.quoteId } });
    if (!q) throw new NotFoundError();
    await operateProject(tx, ctx, q.projectId);
    const vendor = await activeVendor(tx, q.vendorId);
    if (!["RECEIVED", "SHORTLISTED"].includes(q.status)) throw new ValidationError("errors.invalidTransition");
    if (q.validUntil && q.validUntil < new Date()) throw new ValidationError("vendors.quoteExpired");
    let title = vendor.name;
    if (q.rfqId) {
      const rfq = await tx.rFQ.findUniqueOrThrow({ where: { id: q.rfqId } });
      const r = await tx.rFQ.updateMany({ where: { id: rfq.id, status: "OPEN" }, data: { status: "AWARDED" } });
      if (!r.count) throw new ConflictError();
      // awarding a quote that isn't the cheapest received one requires a written justification
      const cheaper = await tx.quote.count({ where: { rfqId: rfq.id, status: { in: ["RECEIVED", "SHORTLISTED"] }, id: { not: q.id }, amount: { lt: q.amount } } });
      if (cheaper && !input.justification?.trim()) throw new ValidationError("errors.validation", { justification: ["vendors.justifyNotLowest"] });
      await tx.quote.updateMany({ where: { rfqId: rfq.id, id: { not: q.id }, status: { in: ["REQUESTED", "RECEIVED", "SHORTLISTED"] } }, data: { status: "REJECTED" } });
      title = `${rfq.code} — ${rfq.title}`;
    }
    await tx.quote.update({ where: { id: q.id }, data: { status: "ACCEPTED" } });
    const code = await nextFinanceCode(tx, ctx.orgId, "PO");
    const po = await tx.purchaseOrder.create({ data: { organizationId: ctx.orgId, projectId: q.projectId, vendorId: q.vendorId, quoteId: q.id, code, title, budgetCategory: input.budgetCategory, amount: q.amount, vatAmount: q.vatAmount, createdById: ctx.userId } });
    await audit(tx, ctx, { action: "quote.award", entityType: "QUOTE", entityId: q.id, projectId: q.projectId, summary: `${vendor.name} → ${po.code}`, meta: { justification: input.justification ?? null } });
    return { purchaseOrderId: po.id, code: po.code };
  });
}

// ── Work orders & vendor portal ─────────────────────────────────────────────

export async function createWorkOrder(ctx: ServiceContext, input: z.output<typeof workOrderSchema>) {
  assertCan(ctx, "vendor.manage");
  return withTenant(scoped(ctx), async (tx) => {
    await operateProject(tx, ctx, input.projectId);
    await activeVendor(tx, input.vendorId);
    const w = await tx.workOrder.create({ data: { ...input, organizationId: ctx.orgId, createdById: ctx.userId } });
    await audit(tx, ctx, { action: "workorder.create", entityType: "WORK_ORDER", entityId: w.id, projectId: w.projectId, summary: w.title });
    return w;
  });
}

const VENDOR_FLOW: Record<string, string[]> = { ISSUED: ["ACCEPTED"], ACCEPTED: ["IN_PROGRESS"], IN_PROGRESS: ["DELIVERED"] };
const AGENCY_FLOW: Record<string, string[]> = { ISSUED: ["CANCELLED"], ACCEPTED: ["CANCELLED"], IN_PROGRESS: ["CANCELLED"], DELIVERED: ["ACCEPTED_BY_AGENCY", "IN_PROGRESS"] };

/**
 * Vendor users progress their own work orders (accept → in progress → delivered).
 * The agency accepts the delivery with a 1–5 rating; on-time is computed from the due date.
 */
export async function setWorkOrderStatus(ctx: ServiceContext, input: { id: string; status: (typeof WO_STATUSES)[number]; rating?: number | null }) {
  return withTenant(scoped(ctx), async (tx) => {
    const w = await tx.workOrder.findUnique({ where: { id: input.id } });
    if (!w) throw new NotFoundError();
    const isVendor = ctx.role === "VENDOR";
    if (isVendor) {
      if (!can(ctx, "vendor.portal") || ctx.vendorId !== w.vendorId) throw new NotFoundError();
      if (!VENDOR_FLOW[w.status]?.includes(input.status)) throw new ValidationError("errors.invalidTransition");
    } else {
      assertCan(ctx, "vendor.manage");
      await operateProject(tx, ctx, w.projectId);
      if (!AGENCY_FLOW[w.status]?.includes(input.status) && !VENDOR_FLOW[w.status]?.includes(input.status)) throw new ValidationError("errors.invalidTransition");
      if (input.status === "ACCEPTED_BY_AGENCY" && !input.rating) throw new ValidationError("errors.validation", { rating: ["vendors.ratingRequired"] });
    }
    const done = input.status === "ACCEPTED_BY_AGENCY";
    const r = await tx.workOrder.updateMany({
      where: { id: w.id, status: w.status },
      data: { status: input.status, ...(done ? { rating: Math.max(1, Math.min(5, Math.round(input.rating!))), onTime: w.dueAt ? await deliveredOnTime(tx, w.id, w.dueAt) : null } : {}) },
    });
    if (!r.count) throw new ConflictError();
    if (done) await refreshVendorRating(tx, w.vendorId);
    await audit(tx, ctx, { action: "workorder.status", entityType: "WORK_ORDER", entityId: w.id, projectId: w.projectId, summary: `${w.title}: ${w.status} → ${input.status}` });
    return { status: input.status };
  });
}

/** On-time means the vendor marked it DELIVERED by the due date (agency acceptance may come later). */
async function deliveredOnTime(tx: Tx, workOrderId: string, dueAt: Date) {
  const ev = await tx.auditEvent.findFirst({ where: { entityType: "WORK_ORDER", entityId: workOrderId, action: "workorder.status", summary: { endsWith: "→ DELIVERED" } }, orderBy: { createdAt: "desc" } });
  return !!ev && ev.createdAt <= dueAt;
}

async function refreshVendorRating(tx: Tx, vendorId: string) {
  const agg = await tx.workOrder.aggregate({ where: { vendorId, status: "ACCEPTED_BY_AGENCY", rating: { not: null } }, _avg: { rating: true } });
  await tx.vendor.update({ where: { id: vendorId }, data: { rating: agg._avg.rating } });
}

/** Vendor portal: only the work orders of the vendor linked to the caller's membership. No pricing of competitors. */
export async function vendorPortal(ctx: ServiceContext) {
  if (ctx.role !== "VENDOR" || !can(ctx, "vendor.portal") || !ctx.vendorId) throw new ForbiddenError();
  return withTenant(scoped(ctx), async (tx) => {
    const vendor = await tx.vendor.findUnique({ where: { id: ctx.vendorId! }, select: { id: true, name: true, nameEn: true } });
    if (!vendor) throw new NotFoundError();
    const workOrders = await tx.workOrder.findMany({ where: { vendorId: vendor.id, status: { not: "CANCELLED" } }, orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }] });
    const projects = await tx.project.findMany({ where: { id: { in: [...new Set(workOrders.map((w) => w.projectId))] } }, select: { id: true, code: true, name: true } });
    const files = await tx.attachment.findMany({ where: { entityType: "WORK_ORDER", entityId: { in: workOrders.map((w) => w.id) }, deletedAt: null } });
    return { vendor, workOrders: workOrders.map((w) => ({ ...w, project: projects.find((p) => p.id === w.projectId) ?? null, files: files.filter((f) => f.entityId === w.id) })) };
  });
}

/** Org-level procurement view: open RFQs and active work orders across visible projects. */
export async function procurementOverview(ctx: ServiceContext) {
  assertCan(ctx, "vendor.view");
  return withTenant(scoped(ctx), async (tx) => {
    const projects = await tx.project.findMany({ where: { ...projectVisibilityWhere(ctx), archivedAt: null }, select: { id: true, code: true, name: true } });
    const pids = projects.map((p) => p.id);
    const [rfqs, workOrders] = await Promise.all([
      tx.rFQ.findMany({ where: { projectId: { in: pids }, status: "OPEN" }, include: { quotes: { select: { status: true } } }, orderBy: { dueAt: "asc" } }),
      tx.workOrder.findMany({ where: { projectId: { in: pids }, status: { in: ["ISSUED", "ACCEPTED", "IN_PROGRESS", "DELIVERED"] } }, orderBy: { dueAt: "asc" } }),
    ]);
    return { projects, rfqs, workOrders };
  });
}
