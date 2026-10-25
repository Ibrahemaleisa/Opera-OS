import type { Tx } from "@/server/db/tenant";
import { BUDGET_CATEGORIES } from "./codes";

/** PO statuses that count as committed spend. */
export const COMMITTED_PO_STATUSES = ["APPROVED", "ISSUED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED"] as const;
/** Expense statuses that count as actual spend. */
export const ACTUAL_EXPENSE_STATUSES = ["APPROVED", "PAID"] as const;

const n = (d: unknown) => Number(d ?? 0);

export interface FinanceRows {
  budgets: { projectId: string; category: string; planned: unknown }[];
  /** committed POs only */
  purchaseOrders: { projectId: string; budgetCategory: string; amount: unknown }[];
  /** approved/paid expenses only */
  expenses: { projectId: string; budgetCategory: string; amount: unknown; purchaseOrderId: string | null }[];
  /** approved change orders only */
  changeOrders: { projectId: string; amountDelta: unknown; costDelta: unknown }[];
  projects: { id: string; contractValue: unknown }[];
}

export interface BudgetLineForecast {
  category: string;
  planned: number;
  committed: number;
  actual: number;
  forecast: number;
  /** planned − forecast: 0 while a line stays within plan, negative by the overrun */
  variance: number;
  overBudget: boolean;
}

export interface ProjectFinanceSummary {
  projectId: string;
  lines: BudgetLineForecast[];
  totals: { planned: number; committed: number; actual: number; forecast: number; changeOrderCost: number };
  contract: { original: number | null; revised: number | null; changeOrders: number };
  /** revised contract − forecast cost */
  margin: { amount: number; ratio: number | null } | null;
  /** revised contract − planned cost: what the plan itself promises */
  plannedMargin: { amount: number; ratio: number | null } | null;
  /** some budget line is forecast above its plan */
  overPlan: boolean;
  /** forecast cost (which is never below plan) exceeds the revised contract */
  overContract: boolean;
  /** committed ÷ planned: how much of the plan is backed by commitments (null without a plan) */
  coverage: number | null;
}

/**
 * Forecast of one budget line: the plan is the floor until spend proves otherwise.
 *   forecast = max(planned, committed POs + expenses not tied to a PO, actual expenses)
 * Expenses billed against a PO are part of that commitment; the others add to it.
 */
export function lineForecast(planned: number, committed: number, unbackedActual: number, actual: number) {
  return Math.max(planned, committed + unbackedActual, actual);
}

/**
 * Honest project margin (ASSUMPTIONS #23):
 *   margin = (contract + approved change-order amounts) − Σ line forecasts − approved change-order costs
 * Because each line's forecast is at least its plan, a plan above the contract always shows a
 * negative margin, never a near-100 % one before procurement starts.
 */
export function summarizeProjectFinance(projectId: string, rows: FinanceRows): ProjectFinanceSummary {
  const own = <T extends { projectId: string }>(xs: T[]) => xs.filter((x) => x.projectId === projectId);
  const budgets = own(rows.budgets);
  const pos = own(rows.purchaseOrders);
  const expenses = own(rows.expenses);
  const cos = own(rows.changeOrders);
  const cats = new Set<string>([...budgets.map((b) => b.category), ...pos.map((p) => p.budgetCategory), ...expenses.map((e) => e.budgetCategory)]);
  const order = BUDGET_CATEGORIES as readonly string[];
  const lines: BudgetLineForecast[] = [...cats]
    .map((category) => {
      const planned = n(budgets.find((b) => b.category === category)?.planned);
      const committed = pos.filter((p) => p.budgetCategory === category).reduce((a, p) => a + n(p.amount), 0);
      const inCat = expenses.filter((e) => e.budgetCategory === category);
      const actual = inCat.reduce((a, e) => a + n(e.amount), 0);
      const unbacked = inCat.filter((e) => !e.purchaseOrderId).reduce((a, e) => a + n(e.amount), 0);
      const forecast = lineForecast(planned, committed, unbacked, actual);
      return { category, planned, committed, actual, forecast, variance: planned - forecast, overBudget: forecast > planned };
    })
    .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  const sum = (k: "planned" | "committed" | "actual" | "forecast") => lines.reduce((a, l) => a + l[k], 0);
  const changeOrderCost = cos.reduce((a, c) => a + n(c.costDelta), 0);
  const changeOrderAmount = cos.reduce((a, c) => a + n(c.amountDelta), 0);
  const p = rows.projects.find((x) => x.id === projectId);
  const original = p && p.contractValue !== null && p.contractValue !== undefined ? n(p.contractValue) : null;
  const revised = original === null ? null : original + changeOrderAmount;
  const planned = sum("planned") + changeOrderCost;
  const forecast = sum("forecast") + changeOrderCost;
  const ratio = (amount: number) => (revised ? amount / revised : null);
  return {
    projectId,
    lines,
    totals: { planned, committed: sum("committed"), actual: sum("actual"), forecast, changeOrderCost },
    contract: { original, revised, changeOrders: changeOrderAmount },
    margin: revised === null ? null : { amount: revised - forecast, ratio: ratio(revised - forecast) },
    plannedMargin: revised === null ? null : { amount: revised - planned, ratio: ratio(revised - planned) },
    overPlan: lines.some((l) => l.overBudget),
    overContract: revised !== null && forecast > revised,
    coverage: planned > 0 ? sum("committed") / planned : null,
  };
}

/** Loads the records behind the summaries for many projects in five queries (tenant-scoped tx). */
export async function loadFinanceSummaries(tx: Tx, projectIds: string[]): Promise<ProjectFinanceSummary[]> {
  if (!projectIds.length) return [];
  const [budgets, purchaseOrders, expenses, changeOrders, projects] = await Promise.all([
    tx.budget.findMany({ where: { projectId: { in: projectIds } }, select: { projectId: true, category: true, planned: true } }),
    tx.purchaseOrder.findMany({ where: { projectId: { in: projectIds }, status: { in: [...COMMITTED_PO_STATUSES] } }, select: { projectId: true, budgetCategory: true, amount: true } }),
    tx.expense.findMany({ where: { projectId: { in: projectIds }, status: { in: [...ACTUAL_EXPENSE_STATUSES] } }, select: { projectId: true, budgetCategory: true, amount: true, purchaseOrderId: true } }),
    tx.changeOrder.findMany({ where: { projectId: { in: projectIds }, status: "APPROVED" }, select: { projectId: true, amountDelta: true, costDelta: true } }),
    tx.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, contractValue: true } }),
  ]);
  const rows: FinanceRows = { budgets, purchaseOrders, expenses, changeOrders, projects };
  return projectIds.map((id) => summarizeProjectFinance(id, rows));
}
