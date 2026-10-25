/**
 * BUSINESS_RULES §7.1 rule 4 (SW-7): the row cap is checked from the sheet dimension before any
 * row is parsed.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { assertRowCap, importMaxRows, xlsxSheetRowCounts } from "@/server/modules/delivery/imports/parse";

async function workbook(rows: number, extraSheet = true) {
  const wb = new ExcelJS.Workbook();
  if (extraSheet) wb.addWorksheet("تعليمات").addRow(["يرجى عدم تعديل هذا الملف"]);
  const ws = wb.addWorksheet("List");
  ws.addRow(["الاسم", "رقم الجوال"]);
  for (let i = 0; i < rows; i++) ws.addRow([`ضيف ${i}`, `055${String(1_000_000 + i).slice(-7)}`]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("SW-7 · import row cap before parsing", () => {
  it("SW-7 reads each sheet's row count from the XLSX without building the workbook", async () => {
    expect(xlsxSheetRowCounts(await workbook(25))).toEqual([1, 26]);
    expect(xlsxSheetRowCounts(Buffer.from("not a zip"))).toBeNull();
  });

  it("SW-7 refuses 12,000 data rows with the default cap of 10,000, and names the cap", async () => {
    expect(importMaxRows()).toBe(10_000);
    const big = await workbook(12_000);
    const t = Date.now();
    let err: unknown;
    try {
      assertRowCap(big, "guests.xlsx");
    } catch (e) {
      err = e;
    }
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(err).toMatchObject({ message: "errors.tooManyRows", fieldErrors: { max: ["10000"], rows: ["12000"] } });
  });

  it("SW-7 accepts exactly the cap (one header row allowed for), and applies the same cap to CSV", async () => {
    expect(() => assertRowCap(Buffer.from(["name,mobile", ...Array.from({ length: 10_000 }, (_, i) => `n${i},0551${String(i).padStart(6, "0")}`)].join("\n")), "list.csv")).not.toThrow();
    expect(() => assertRowCap(Buffer.from(["name,mobile", ...Array.from({ length: 10_001 }, (_, i) => `n${i},0551${String(i).padStart(6, "0")}`)].join("\n")), "list.csv")).toThrow("errors.tooManyRows");
    expect(() => assertRowCap(Buffer.from("name\nA\nB\n"), "small.csv", 2)).not.toThrow();
    expect(() => assertRowCap(Buffer.from("name\nA\nB\nC\n"), "small.csv", 2)).toThrow("errors.tooManyRows");
  });

  it("SW-7 honours IMPORT_MAX_ROWS", async () => {
    const before = process.env.IMPORT_MAX_ROWS;
    process.env.IMPORT_MAX_ROWS = "20";
    try {
      expect(importMaxRows()).toBe(20);
      expect(() => assertRowCap(Buffer.from(["name", ...Array.from({ length: 21 }, (_, i) => `n${i}`)].join("\n")), "x.csv")).toThrow("errors.tooManyRows");
    } finally {
      if (before === undefined) delete process.env.IMPORT_MAX_ROWS;
      else process.env.IMPORT_MAX_ROWS = before;
    }
  });
});
