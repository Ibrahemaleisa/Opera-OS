import type { Tx } from "@/server/db/tenant";

export const BUDGET_CATEGORIES = ["VENUE", "PRODUCTION", "LOGISTICS", "STAFFING", "PRINTING", "DELIVERY", "HOSPITALITY", "AV", "CONTINGENCY", "OTHER"] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];

/**
 * Allocates the next human-readable document code per organization and year (e.g. PO-2026-0007).
 * Serialized with a transaction-scoped advisory lock so concurrent requests can't collide.
 */
export async function nextFinanceCode(tx: Tx, orgId: string, kind: "PO" | "RFQ" | "CO", now = new Date()) {
  const year = new Intl.DateTimeFormat("en", { timeZone: "Asia/Riyadh", year: "numeric" }).format(now);
  const prefix = `${kind}-${year}-`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`code:${orgId}:${prefix}`}))`;
  const where = { organizationId: orgId, code: { startsWith: prefix } };
  const select = { code: true } as const;
  const orderBy = { code: "desc" } as const;
  const last =
    kind === "PO" ? await tx.purchaseOrder.findFirst({ where, select, orderBy })
    : kind === "RFQ" ? await tx.rFQ.findFirst({ where, select, orderBy })
    : await tx.changeOrder.findFirst({ where, select, orderBy });
  const n = last ? Number(last.code.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, "0")}`;
}
