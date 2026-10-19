import ExcelJS from "exceljs";
import Papa from "papaparse";
import { ValidationError } from "@/server/errors";
import { normalizeHeader, CANONICAL_FIELDS } from "./canonical";

export const MAX_IMPORT_ROWS = 20_000;
export const MAX_IMPORT_COLUMNS = 80;

export interface ParsedSheet {
  name: string;
  /** raw grid (strings / numbers), trimmed to used range */
  grid: (string | number | null)[][];
}

function cellValue(v: ExcelJS.CellValue): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return typeof v === "string" ? v.trim() || null : v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    // formulas: take the cached result only — formulas are never evaluated
    if ("result" in v) return cellValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("").trim() || null;
    if ("hyperlink" in v) return String((v as ExcelJS.CellHyperlinkValue).hyperlink || (v as ExcelJS.CellHyperlinkValue).text);
    if ("text" in v) return String((v as { text: unknown }).text);
    if ("error" in v) return null;
  }
  return String(v);
}

/** Parses XLSX or CSV safely (row/column caps, no formula evaluation, no macros). */
export async function parseWorkbook(buf: Buffer, fileName: string): Promise<ParsedSheet[]> {
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "csv" || ext === "txt") {
    const text = buf.toString("utf8").replace(/^﻿/, "");
    const res = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
    const grid = res.data.slice(0, MAX_IMPORT_ROWS + 20).map((r) => r.slice(0, MAX_IMPORT_COLUMNS).map((c) => (c?.trim() ? c.trim() : null)));
    return [{ name: "CSV", grid }];
  }
  if (ext !== "xlsx") throw new ValidationError("errors.fileType");
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new ValidationError("errors.fileType");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new ValidationError("errors.fileType");
  }
  const sheets: ParsedSheet[] = [];
  wb.eachSheet((ws) => {
    if (ws.state !== "visible" && ws.state !== undefined) return;
    const grid: (string | number | null)[][] = [];
    const maxCol = Math.min(ws.actualColumnCount || ws.columnCount, MAX_IMPORT_COLUMNS);
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber > MAX_IMPORT_ROWS + 20) return;
      const r: (string | number | null)[] = [];
      for (let c = 1; c <= maxCol; c++) r.push(cellValue(row.getCell(c).value));
      grid[rowNumber - 1] = r;
    });
    for (let i = 0; i < grid.length; i++) grid[i] ??= [];
    // trim trailing empty rows
    while (grid.length && grid[grid.length - 1].every((c) => c === null || c === "")) grid.pop();
    sheets.push({ name: ws.name, grid });
  });
  return sheets;
}

const KNOWN = new Set(CANONICAL_FIELDS.flatMap((f) => [f.key, f.ar, f.en, ...f.synonyms].map(normalizeHeader)));

/**
 * Detects the header row within the first 10 rows: the row with the most cells that match
 * known synonyms, tie-broken by number of non-empty text cells.
 */
export function detectHeaderRow(grid: ParsedSheet["grid"]): number {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(10, grid.length); i++) {
    const row = grid[i] ?? [];
    const texts = row.filter((c) => typeof c === "string" && c.length > 0) as string[];
    const known = texts.filter((t) => KNOWN.has(normalizeHeader(t))).length;
    const score = known * 10 + texts.length - row.filter((c) => typeof c === "number").length * 2;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best + 1; // 1-based
}

export function extractTable(grid: ParsedSheet["grid"], headerRow: number) {
  const headerCells = grid[headerRow - 1] ?? [];
  const headers: string[] = [];
  const seen = new Map<string, number>();
  headerCells.forEach((h, i) => {
    let name = h === null || h === "" ? `Column ${i + 1}` : String(h).trim();
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n) name = `${name} (${n + 1})`;
    headers.push(name);
  });
  const rows: { rowNumber: number; values: Record<string, string | number | null> }[] = [];
  for (let i = headerRow; i < grid.length; i++) {
    const r = grid[i] ?? [];
    if (r.every((c) => c === null || c === "")) continue;
    const values: Record<string, string | number | null> = {};
    headers.forEach((h, c) => (values[h] = r[c] ?? null));
    rows.push({ rowNumber: i + 1, values });
  }
  if (rows.length > MAX_IMPORT_ROWS) throw new ValidationError("errors.fileTooLarge");
  return { headers, rows };
}
