/** BUSINESS_RULES §8 KD-2, KD-3, KD-4: import sheet choice, formula-looking text, XLSX phone cells. */
import { describe, expect, it } from "vitest";
import { pickSheet, type ParsedSheet } from "@/server/modules/delivery/imports/parse";
import { normalizeRow } from "@/server/modules/delivery/imports/normalize";
import { DEFAULT_OPTIONS } from "@/server/modules/delivery/imports/normalize";
import { xlsxText } from "@/server/modules/delivery/export";

const sheet = (name: string, grid: ParsedSheet["grid"]): ParsedSheet => ({ name, grid });
const guests = (n: number) => [["الاسم", "رقم الجوال", "العنوان", "المدينة"], ...Array.from({ length: n }, (_, i) => [`ضيف ${i}`, `05512345${String(i).padStart(2, "0")}`, "حي النخيل", "الرياض"])];

describe("KD-2 · the import sheet is chosen by header score", () => {
  it("KD-2 a prose instructions sheet placed first is never picked over a guest sheet", () => {
    const decoy = sheet("تعليمات", [["يرجى عدم تعديل هذا الملف"], ["آخر تحديث: الأحد"], ["المسؤول: إدارة المراسم"]]);
    const list = sheet("المدعوين", [["قائمة كبار الضيوف — سري"], ...guests(3)]);
    expect(pickSheet([decoy, list])).toEqual({ sheet: list, headerRow: 2 });
  });

  it("KD-2 ties go to the sheet with more data rows; a sheet with < 2 recognised headers or < 2 rows never wins while another qualifies", () => {
    const small = sheet("Small", guests(2));
    const big = sheet("Big", guests(5));
    expect(pickSheet([small, big])?.sheet.name).toBe("Big");
    const oneRow = sheet("OneRow", [["الاسم", "رقم الجوال", "العنوان", "المدينة", "الجهة"], ["ضيف", "0551234567", "حي", "الرياض", "وزارة"]]);
    expect(pickSheet([oneRow, small])?.sheet.name).toBe("Small");
    const oneHeader = sheet("OneHeader", [["الاسم", "x", "y"], ...Array.from({ length: 50 }, () => ["a", "b", "c"])]);
    expect(pickSheet([oneHeader, small])?.sheet.name).toBe("Small");
    // nothing qualifies: the first sheet with data is still offered (the user can pick another)
    expect(pickSheet([sheet("Empty", []), oneRow])?.sheet.name).toBe("OneRow");
  });
});

describe("KD-3 · formula-looking text", () => {
  const map = { nameAr: "name", mobile: "mobile", address: "address", city: "city", organizationName: "org", notes: "notes" };
  const run = (values: Record<string, string>) => normalizeRow({ mobile: "0551234567", address: "حي النخيل", city: "الرياض", ...values }, map as never, DEFAULT_OPTIONS);

  it("KD-3 a name, organisation, address or note starting with = + - @ is a warning, never an error, and imported as literal text", () => {
    for (const v of ["=HYPERLINK(\"http://evil\",\"x\")", "+cmd", "-2+3", "@SUM(1)"]) {
      const r = run({ name: v });
      expect(r.errors).toEqual([]);
      // a Latin value moves to the English name column (NAME_LANG_SWAPPED); the warning follows it
      expect(r.warnings.filter((w) => w.code === "FORMULA_LIKE").map((w) => w.field)).toEqual([r.normalized.nameAr ? "nameAr" : "nameEn"]);
      expect(r.normalized.nameAr ?? r.normalized.nameEn).toBe(v);
    }
    expect(run({ name: "ضيف", org: "=x" }).warnings).toContainEqual({ field: "organizationName", code: "FORMULA_LIKE" });
    expect(run({ name: "ضيف", address: "@home" }).warnings).toContainEqual({ field: "address", code: "FORMULA_LIKE" });
    expect(run({ name: "ضيف", notes: "-urgent" }).warnings).toContainEqual({ field: "notes", code: "FORMULA_LIKE" });
  });

  it("KD-3 phones are exempt for + and ordinary text gets no warning", () => {
    const r = run({ name: "سعادة أحمد", mobile: "+966551234567" });
    expect(r.warnings.filter((w) => w.code === "FORMULA_LIKE")).toEqual([]);
  });
});

describe("KD-4 · XLSX cells", () => {
  it("KD-4 an E.164 phone in a phone column is written unprefixed; = and @ keep the apostrophe; + and - elsewhere are inert text", () => {
    expect(xlsxText("+966551234567", { phone: true })).toBe("+966551234567");
    expect(xlsxText("+966551234567")).toBe("+966551234567");
    expect(xlsxText("+1 (555) 0100", { phone: true })).toBe("+1 (555) 0100");
    expect(xlsxText("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(xlsxText("@SUM(1+1)", { phone: true })).toBe("'@SUM(1+1)");
    expect(xlsxText(null)).toBe("");
  });
});
