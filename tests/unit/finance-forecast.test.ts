import { describe, expect, it } from "vitest";
import { lineForecast, summarizeProjectFinance, type FinanceRows } from "@/server/modules/finance/forecast";

describe("honest margin (ASSUMPTIONS #23)", () => {
  it("forecasts each line as max(planned, committed + unbacked, actual) and adds change-order cost", () => {
    const rows: FinanceRows = {
      budgets: [
        { projectId: "p", category: "PRODUCTION", planned: 100_000 },
        { projectId: "p", category: "PRINTING", planned: 50_000 },
      ],
      purchaseOrders: [
        { projectId: "p", budgetCategory: "PRODUCTION", amount: 120_000 },
        { projectId: "p", budgetCategory: "PRINTING", amount: 10_000 },
      ],
      expenses: [
        { projectId: "p", budgetCategory: "PRINTING", amount: 7_000, purchaseOrderId: "po-printing" },
        { projectId: "p", budgetCategory: "PRINTING", amount: 5_000, purchaseOrderId: null },
        { projectId: "p", budgetCategory: "LOGISTICS", amount: 3_000, purchaseOrderId: null },
      ],
      changeOrders: [{ projectId: "p", amountDelta: 30_000, costDelta: 18_000 }],
      projects: [{ id: "p", contractValue: 200_000 }],
    };
    const s = summarizeProjectFinance("p", rows);
    const line = (c: string) => s.lines.find((l) => l.category === c)!;
    expect(line("PRODUCTION")).toMatchObject({ planned: 100_000, committed: 120_000, actual: 0, forecast: 120_000, variance: -20_000, overBudget: true });
    // 10,000 PO + 5,000 unbacked = 15,000 and 12,000 actual both stay under the 50,000 plan
    expect(line("PRINTING")).toMatchObject({ planned: 50_000, committed: 10_000, actual: 12_000, forecast: 50_000, variance: 0, overBudget: false });
    expect(line("LOGISTICS")).toMatchObject({ planned: 0, forecast: 3_000, overBudget: true });
    expect(s.totals).toEqual({ planned: 168_000, committed: 130_000, actual: 15_000, forecast: 191_000, changeOrderCost: 18_000 });
    expect(s.contract).toEqual({ original: 200_000, revised: 230_000, changeOrders: 30_000 });
    expect(s.margin?.amount).toBe(39_000);
    expect(s.margin?.ratio).toBeCloseTo(39_000 / 230_000, 6);
    expect(s.plannedMargin?.amount).toBe(62_000);
    expect(s.overPlan).toBe(true);
    expect(s.overContract).toBe(false);
    expect(s.coverage).toBeCloseTo(130_000 / 168_000, 6);
  });

  it("a plan above the contract is a negative margin before any spend (was +100 %)", () => {
    const rows: FinanceRows = {
      budgets: [{ projectId: "p", category: "VENUE", planned: 255_000 }, { projectId: "p", category: "DELIVERY", planned: 1_105_000 }],
      purchaseOrders: [],
      expenses: [],
      changeOrders: [],
      projects: [{ id: "p", contractValue: 1_150_000 }],
    };
    const s = summarizeProjectFinance("p", rows);
    expect(s.totals.planned).toBe(1_360_000);
    expect(s.totals.forecast).toBe(1_360_000);
    expect(s.margin).toEqual({ amount: -210_000, ratio: -210_000 / 1_150_000 });
    expect(s.overContract).toBe(true);
    expect(s.coverage).toBe(0);
  });

  it("without a contract value there is no margin, and a lone line keeps the max rule", () => {
    expect(lineForecast(5_000, 2_000, 0, 0)).toBe(5_000);
    expect(lineForecast(5_000, 4_000, 2_500, 1_000)).toBe(6_500);
    expect(lineForecast(0, 0, 0, 900)).toBe(900);
    const s = summarizeProjectFinance("p", { budgets: [], purchaseOrders: [], expenses: [], changeOrders: [], projects: [{ id: "p", contractValue: null }] });
    expect(s.margin).toBeNull();
    expect(s.overContract).toBe(false);
    expect(s.coverage).toBeNull();
  });
});
