import { z } from "zod";
import type { ServiceContext } from "@/server/authz/context";
import type { Budget } from "@/generated/prisma/client";
import { assertCan, assertNotArchived, can, computeProjectScope, projectScope, projectVisibilityWhere, type ProjectScope } from "@/server/authz/policy";
import { casUpdate } from "@/server/concurrency";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { requestApprovalTx } from "@/server/modules/approvals/service";
import { BUDGET_CATEGORIES, nextFinanceCode } from "./codes";
import { COMMITTED_PO_STATUSES, loadFinanceSummaries } from "./forecast";

export { BUDGET_CATEGORIES };

const money = z.coerce.number().min(0).max(1e11);
const optText = (max = 500) => z.string().trim().max(max).nullish();

export const budgetSchema = z.object({ projectId: z.string(), category: z.enum(BUDGET_CATEGORIES), planned: money, notes: optText(1000), version: z.number().int().optional() });
export const poSchema = z.object({ projectId: z.string(), vendorId: z.string(), title: z.string().trim().min(2).max(200), budgetCategory: z.enum(BUDGET_CATEGORIES), amount: money.refine((n) => n > 0, "finance.amountPositive"), vatAmount: money.default(0) });
export const expenseSchema = z.object({ projectId: z.string(), budgetCategory: z.enum(BUDGET_CATEGORIES), vendorId: z.string().nullish(), purchaseOrderId: z.string().nullish(), description: z.string().trim().min(3).max(500), amount: money.refine((n) => n > 0, "finance.amountPositive"), vatAmount: money.default(0), incurredAt: z.coerce.date() });
export const changeOrderSchema = z.object({ projectId: z.string(), title: z.string().trim().min(3).max(200), description: optText(4000), amountDelta: z.coerce.number().min(-1e11).max(1e11), costDelta: z.coerce.number().min(-1e11).max(1e11).default(0), clientVisible: z.boolean().default(true) });

/** PO statuses that count as committed spend. */
const COMMITTED = COMMITTED_PO_STATUSES;
const scoped = (ctx: ServiceContext) => ({ orgId: ctx.orgId, userId: ctx.userId });
const n = (d: unknown) => Number(d ?? 0);

async function financeScope(tx: Tx, ctx: ServiceContext, projectId: string): Promise<ProjectScope> {
  const s = await projectScope(tx, ctx, projectId);
  if (!s.finance) throw (s.clientView || s.fieldOnly ? new NotFoundError() : new ForbiddenError());
  return s;
}

/**
 * Finance management on a project. In archived projects only the financial tail stays open
 * (BUSINESS_RULES §1.5: PO transitions, expense decisions and payment, change-order decisions):
 * pass `tail: true` from those paths; everything else is refused with errors.projectArchived.
 */
async function managedFinance(tx: Tx, ctx: ServiceContext, projectId: string, opts: { tail?: boolean } = {}) {
  assertCan(ctx, "finance.manage");
  const s = await financeScope(tx, ctx, projectId);
  if (!opts.tail) assertNotArchived(s);
  return s;
}

async function threshold(tx: Tx, orgId: string) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
  return Number((org.settings as { financeApprovalThreshold?: number } | null)?.financeApprovalThreshold ?? 50000);
}

/**
 * Planned vs committed vs actual per budget category, computed from records (never stored
 * aggregates). The forecast rule lives in ./forecast so the health score and the operations
 * board use the same numbers.
 */
const computeSummary = (tx: Tx, projectIds: string[]) => loadFinanceSummaries(tx, projectIds);

// ── Queries ─────────────────────────────────────────────────────────────────

export async function getProjectFinance(ctx: ServiceContext, projectId: string) {
  return withTenant(scoped(ctx), async (tx) => {
    const scope = await financeScope(tx, ctx, projectId);
    const [summary] = await computeSummary(tx, [projectId]);
    const [pos, expenses, changeOrders, vendors, approvals, limit, budgets] = await Promise.all([
      tx.purchaseOrder.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } }),
      tx.expense.findMany({ where: { projectId }, orderBy: { incurredAt: "desc" } }),
      tx.changeOrder.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } }),
      tx.vendor.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
      tx.approval.findMany({ where: { projectId, entityType: { in: ["PURCHASE_ORDER", "EXPENSE", "CHANGE_ORDER"] } }, orderBy: { createdAt: "desc" } }),
      threshold(tx, ctx.orgId),
      tx.budget.findMany({ where: { projectId }, select: { category: true, version: true, notes: true } }),
    ]);
    const evidence = await tx.attachment.findMany({ where: { entityType: "EXPENSE", entityId: { in: expenses.map((e) => e.id) }, deletedAt: null }, orderBy: { createdAt: "desc" } });
    const approvalOf = (type: string, id: string) => approvals.find((a) => a.entityType === type && a.entityId === id) ?? null;
    const vname = (id: string | null) => vendors.find((v) => v.id === id)?.name ?? null;
    return {
      project: { id: scope.project.id, code: scope.project.code, name: scope.project.name, currency: scope.project.currency },
      canManage: can(ctx, "finance.manage"),
      // archived projects keep only the financial tail (§1.5): no new budget, POs, expenses or change orders
      archived: scope.archived,
      // the version each budget line was loaded at (§6): an update carries it
      budgetVersions: Object.fromEntries(budgets.map((b) => [b.category, b.version])) as Record<string, number>,
      budgetNotes: Object.fromEntries(budgets.map((b) => [b.category, b.notes])) as Record<string, string | null>,
      canApprove: can(ctx, "finance.approve"),
      threshold: limit,
      summary,
      purchaseOrders: pos.map((p) => ({ ...p, amount: n(p.amount), vatAmount: n(p.vatAmount), vendorName: vname(p.vendorId), approval: approvalOf("PURCHASE_ORDER", p.id), needsApproval: n(p.amount) + n(p.vatAmount) >= limit })),
      expenses: expenses.map((e) => ({ ...e, amount: n(e.amount), vatAmount: n(e.vatAmount), vendorName: vname(e.vendorId), evidence: evidence.filter((x) => x.entityId === e.id), evidenceCount: evidence.filter((x) => x.entityId === e.id).length, approval: approvalOf("EXPENSE", e.id) })),
      changeOrders: changeOrders.map((c) => ({ ...c, amountDelta: n(c.amountDelta), costDelta: n(c.costDelta), approval: approvalOf("CHANGE_ORDER", c.id) })),
      vendors: vendors.filter((v) => v.status !== "BLACKLISTED"),
    };
  });
}

/** Portfolio finance across projects the caller can see with finance scope. */
export async function financeOverview(ctx: ServiceContext) {
  assertCan(ctx, "finance.view");
  return withTenant(scoped(ctx), async (tx) => {
    const projects = await tx.project.findMany({ where: { ...projectVisibilityWhere(ctx), archivedAt: null }, orderBy: { createdAt: "desc" } });
    // finance scope for every project from one membership query, evaluated in memory (KD-5):
    // the statement count stays constant in the number of projects
    const members = await tx.projectMember.findMany({ where: { userId: ctx.userId, projectId: { in: projects.map((p) => p.id) } } });
    const byProject = new Map(members.map((m) => [m.projectId, m]));
    const visible = projects.filter((p) => {
      try {
        return computeProjectScope(ctx, p, byProject.get(p.id) ?? null).finance;
      } catch {
        return false; // no access → not listed
      }
    });
    const ids = visible.map((p) => p.id);
    const [summaries, pending] = await Promise.all([
      computeSummary(tx, ids),
      tx.approval.findMany({ where: { projectId: { in: ids }, status: "PENDING", entityType: { in: ["PURCHASE_ORDER", "EXPENSE", "CHANGE_ORDER"] } }, orderBy: { createdAt: "asc" } }),
    ]);
    const byId = new Map(summaries.map((s) => [s.projectId, s]));
    return { projects: visible.map((p) => ({ id: p.id, code: p.code, name: p.name, currency: p.currency, status: p.status, ...byId.get(p.id)! })), pendingApprovals: pending };
  });
}

// ── Budgets & contract ──────────────────────────────────────────────────────

export async function saveBudget(ctx: ServiceContext, input: z.output<typeof budgetSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    await managedFinance(tx, ctx, input.projectId);
    const { version, ...line } = input;
    const before = await tx.budget.findUnique({ where: { projectId_category: { projectId: input.projectId, category: input.category } } });
    // an existing line is a protected record (§6): updating it needs the version the user loaded
    const b = before
      ? await casUpdate<Budget>({ tx, ctx, model: "budget", id: before.id, version, data: { planned: line.planned, notes: line.notes ?? null }, entityType: "BUDGET" })
      : await tx.budget.create({ data: { ...line, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: "budget.set", entityType: "BUDGET", entityId: b.id, projectId: b.projectId, summary: b.category, before: { planned: before ? n(before.planned) : null }, after: { planned: input.planned } });
    return b;
  });
}

export async function setContractValue(ctx: ServiceContext, input: { projectId: string; contractValue: number | null }) {
  return withTenant(scoped(ctx), async (tx) => {
    const s = await managedFinance(tx, ctx, input.projectId);
    await tx.project.update({ where: { id: input.projectId }, data: { contractValue: input.contractValue } });
    await audit(tx, ctx, { action: "project.contract_value", entityType: "PROJECT", entityId: input.projectId, projectId: input.projectId, before: { contractValue: s.project.contractValue === null ? null : n(s.project.contractValue) }, after: { contractValue: input.contractValue } });
    return null;
  });
}

// ── Purchase orders ─────────────────────────────────────────────────────────

export async function createPurchaseOrder(ctx: ServiceContext, input: z.output<typeof poSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    await managedFinance(tx, ctx, input.projectId);
    const v = await tx.vendor.findUnique({ where: { id: input.vendorId } });
    if (!v) throw new NotFoundError();
    if (v.status === "BLACKLISTED") throw new ValidationError("vendors.blacklisted");
    const code = await nextFinanceCode(tx, ctx.orgId, "PO");
    const po = await tx.purchaseOrder.create({ data: { ...input, code, organizationId: ctx.orgId, createdById: ctx.userId } });
    await audit(tx, ctx, { action: "po.create", entityType: "PURCHASE_ORDER", entityId: po.id, projectId: po.projectId, summary: `${po.code} ${po.title}` });
    return po;
  });
}

/**
 * Submits a draft PO. At or above the organization's threshold (amount incl. VAT) it requires
 * a finance approver other than the requester; below it the PO is approved directly (audited).
 */
export async function submitPurchaseOrder(ctx: ServiceContext, poId: string) {
  return withTenant(scoped(ctx), async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po) throw new NotFoundError();
    await managedFinance(tx, ctx, po.projectId);
    if (po.status !== "DRAFT") throw new ValidationError("errors.invalidTransition");
    const total = n(po.amount) + n(po.vatAmount);
    const limit = await threshold(tx, ctx.orgId);
    if (total >= limit) {
      await requestApprovalTx(tx, ctx, { projectId: po.projectId, entityType: "PURCHASE_ORDER", entityId: po.id, title: `${po.code} — ${po.title}`, description: `${total.toFixed(2)} ≥ ${limit.toFixed(2)}`, approverType: "INTERNAL", approverUserId: null, dueAt: null });
      return { status: "PENDING_APPROVAL" as const };
    }
    const r = await tx.purchaseOrder.updateMany({ where: { id: po.id, status: "DRAFT" }, data: { status: "APPROVED" } });
    if (!r.count) throw new ConflictError();
    await audit(tx, ctx, { action: "po.auto_approved", entityType: "PURCHASE_ORDER", entityId: po.id, projectId: po.projectId, summary: `${po.code}: ${total.toFixed(2)} < ${limit.toFixed(2)}` });
    return { status: "APPROVED" as const };
  });
}

const PO_FLOW: Record<string, string[]> = { APPROVED: ["ISSUED", "CANCELLED"], ISSUED: ["PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"], PARTIALLY_RECEIVED: ["RECEIVED"], RECEIVED: ["CLOSED"], DRAFT: ["CANCELLED"] };

export async function setPurchaseOrderStatus(ctx: ServiceContext, input: { id: string; status: "ISSUED" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CLOSED" | "CANCELLED" }) {
  return withTenant(scoped(ctx), async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id: input.id } });
    if (!po) throw new NotFoundError();
    // receive / close / cancel are the financial tail (§1.5); issuing new spend is not
    await managedFinance(tx, ctx, po.projectId, { tail: input.status !== "ISSUED" });
    if (!PO_FLOW[po.status]?.includes(input.status)) throw new ValidationError("errors.invalidTransition");
    const r = await tx.purchaseOrder.updateMany({ where: { id: po.id, status: po.status }, data: { status: input.status, ...(input.status === "ISSUED" ? { issuedAt: new Date() } : {}) } });
    if (!r.count) throw new ConflictError();
    await audit(tx, ctx, { action: "po.status", entityType: "PURCHASE_ORDER", entityId: po.id, projectId: po.projectId, summary: `${po.code}: ${po.status} → ${input.status}` });
    return { status: input.status };
  });
}

// ── Expenses ────────────────────────────────────────────────────────────────

/** Records an expense. Anyone operating on the project may submit; approval needs evidence and a separate approver. */
export async function createExpense(ctx: ServiceContext, input: z.output<typeof expenseSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    const s = await projectScope(tx, ctx, input.projectId);
    if (s.clientView || s.fieldOnly) throw new NotFoundError();
    assertNotArchived(s);
    if (!s.finance && !(s.operate && can(ctx, "task.manage"))) throw new ForbiddenError();
    if (input.purchaseOrderId) {
      const po = await tx.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, projectId: input.projectId, status: { in: [...COMMITTED] } } });
      if (!po) throw new ValidationError("errors.validation", { purchaseOrderId: ["finance.poNotCommitted"] });
      input.vendorId ??= po.vendorId;
      input.budgetCategory = po.budgetCategory as never;
    }
    if (input.vendorId && !(await tx.vendor.findUnique({ where: { id: input.vendorId } }))) throw new NotFoundError();
    if (input.incurredAt > new Date(Date.now() + 86400_000)) throw new ValidationError("errors.validation", { incurredAt: ["finance.futureDate"] });
    const e = await tx.expense.create({ data: { ...input, organizationId: ctx.orgId, submittedById: ctx.userId } });
    await audit(tx, ctx, { action: "expense.create", entityType: "EXPENSE", entityId: e.id, projectId: e.projectId, summary: `${e.description}: ${n(e.amount).toFixed(2)}` });
    return e;
  });
}

export async function requestExpenseApproval(ctx: ServiceContext, expenseId: string) {
  return withTenant(scoped(ctx), async (tx) => {
    const e = await tx.expense.findUnique({ where: { id: expenseId } });
    if (!e) throw new NotFoundError();
    const s = await projectScope(tx, ctx, e.projectId);
    if (!s.finance && e.submittedById !== ctx.userId) throw new ForbiddenError();
    if (e.status !== "SUBMITTED" && e.status !== "REJECTED") throw new ValidationError("errors.invalidTransition");
    const evidence = await tx.attachment.count({ where: { entityType: "EXPENSE", entityId: e.id, deletedAt: null } });
    if (!evidence) throw new ValidationError("finance.evidenceRequired");
    if (e.status === "REJECTED") await tx.expense.update({ where: { id: e.id }, data: { status: "SUBMITTED" } });
    return requestApprovalTx(tx, ctx, { projectId: e.projectId, entityType: "EXPENSE", entityId: e.id, title: `${e.description} — ${(n(e.amount) + n(e.vatAmount)).toFixed(2)}`, description: null, approverType: "INTERNAL", approverUserId: null, dueAt: null });
  });
}

export async function markExpensePaid(ctx: ServiceContext, expenseId: string) {
  return withTenant(scoped(ctx), async (tx) => {
    const e = await tx.expense.findUnique({ where: { id: expenseId } });
    if (!e) throw new NotFoundError();
    await managedFinance(tx, ctx, e.projectId, { tail: true });
    const r = await tx.expense.updateMany({ where: { id: e.id, status: "APPROVED" }, data: { status: "PAID" } });
    if (!r.count) throw new ValidationError("errors.invalidTransition");
    await audit(tx, ctx, { action: "expense.paid", entityType: "EXPENSE", entityId: e.id, projectId: e.projectId, summary: e.description });
    return { status: "PAID" as const };
  });
}

// ── Change orders ───────────────────────────────────────────────────────────

export async function createChangeOrder(ctx: ServiceContext, input: z.output<typeof changeOrderSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    await managedFinance(tx, ctx, input.projectId);
    const code = await nextFinanceCode(tx, ctx.orgId, "CO");
    const c = await tx.changeOrder.create({ data: { ...input, code, organizationId: ctx.orgId, createdById: ctx.userId, status: "PENDING" } });
    await audit(tx, ctx, { action: "changeorder.create", entityType: "CHANGE_ORDER", entityId: c.id, projectId: c.projectId, summary: `${c.code} ${c.title}` });
    return c;
  });
}

/** Change orders are approved by the client (client-visible) or internally by a finance approver. */
export async function submitChangeOrder(ctx: ServiceContext, input: { id: string; approverType: "INTERNAL" | "CLIENT"; approverUserId?: string | null }) {
  return withTenant(scoped(ctx), async (tx) => {
    const c = await tx.changeOrder.findUnique({ where: { id: input.id } });
    if (!c) throw new NotFoundError();
    // submitting an existing change order for its decision belongs to the financial tail (§1.5)
    const s = await managedFinance(tx, ctx, c.projectId, { tail: true });
    if (c.status !== "PENDING" || c.approvalId) throw new ValidationError("errors.invalidTransition");
    if (input.approverType === "CLIENT" && (!c.clientVisible || !s.project.clientPortal)) throw new ValidationError("finance.clientApprovalUnavailable");
    return requestApprovalTx(tx, ctx, { projectId: c.projectId, entityType: "CHANGE_ORDER", entityId: c.id, title: `${c.code} — ${c.title}`, description: c.description, approverType: input.approverType, approverUserId: input.approverUserId ?? null, dueAt: null });
  });
}
