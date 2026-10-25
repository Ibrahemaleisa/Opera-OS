import { inflateRawSync, constants as zlibConstants } from "node:zlib";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { ValidationError } from "@/server/errors";
import { normalizeHeader, CANONICAL_FIELDS } from "./canonical";

/** Data rows an import may hold (BUSINESS_RULES §7.1 rule 4; IMPORT_MAX_ROWS, default 10,000 — an assumption). */
export function importMaxRows(): number {
  const n = Number(process.env.IMPORT_MAX_ROWS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000;
}
/** @deprecated use importMaxRows(); kept for importers of the old constant */
export const MAX_IMPORT_ROWS = importMaxRows();
export const MAX_IMPORT_COLUMNS = 80;

// ── Row cap before parsing (§7.1 rule 4) ────────────────────────────────────

/** Reads the entries of a ZIP file (XLSX) from its central directory, without unpacking anything. */
function zipEntries(buf: Buffer): { name: string; method: number; compressedSize: number; dataStart: number }[] {
  const out: { name: string; method: number; compressedSize: number; dataStart: number }[] = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (local + 30 <= buf.length && buf.readUInt32LE(local) === 0x04034b50) {
      const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      out.push({ name, method, compressedSize, dataStart });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function entryText(buf: Buffer, e: { method: number; compressedSize: number; dataStart: number }, maxCompressed?: number): string {
  const end = Math.min(buf.length, e.dataStart + (maxCompressed ? Math.min(e.compressedSize, maxCompressed) : e.compressedSize));
  const raw = buf.subarray(e.dataStart, end);
  if (e.method === 0) return raw.toString("utf8");
  if (e.method !== 8) return "";
  try {
    return inflateRawSync(raw, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * The number of rows of each worksheet, read from its `<dimension>` (or, when a writer left it out,
 * by counting `<row>` elements) — never by building the workbook. Null when the file isn't a ZIP.
 */
export function xlsxSheetRowCounts(buf: Buffer): number[] | null {
  const sheets = zipEntries(buf).filter((e) => /^xl\/worksheets\/[^/]+\.xml$/i.test(e.name));
  if (!sheets.length) return null;
  return sheets.map((e) => {
    const head = entryText(buf, e, 64 * 1024);
    const dim = /<dimension\b[^>]*\bref="[A-Z]+\d+:[A-Z]+(\d+)"/i.exec(head);
    if (dim) return Number(dim[1]);
    const xml = entryText(buf, e);
    let last = 0;
    for (const m of xml.matchAll(/<row\b[^>]*?\br="(\d+)"/g)) last = Math.max(last, Number(m[1]));
    return last || (xml.match(/<row\b/g)?.length ?? 0);
  });
}

/** Rows in a CSV, counted by line breaks (an upper bound: quoted line breaks count too). */
function csvRowCount(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  if (buf.length && buf[buf.length - 1] !== 0x0a) n++;
  return n;
}

/**
 * Refuses a file whose data rows exceed the cap before any row is parsed (SW-7). One header row is
 * allowed for; a workbook is judged by its largest sheet.
 */
export function assertRowCap(buf: Buffer, fileName: string, max = importMaxRows()) {
  const ext = fileName.toLowerCase().split(".").pop();
  const rows = ext === "csv" || ext === "txt" ? csvRowCount(buf) : Math.max(0, ...(xlsxSheetRowCounts(buf) ?? [0]));
  if (rows - 1 > max) throw new ValidationError("errors.tooManyRows", { file: ["errors.tooManyRows"], max: [String(max)], rows: [String(rows - 1)] });
}

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
    const grid = res.data.slice(0, importMaxRows() + 20).map((r) => r.slice(0, MAX_IMPORT_COLUMNS).map((c) => (c?.trim() ? c.trim() : null)));
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
      if (rowNumber > importMaxRows() + 20) return;
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

/**
 * A sheet's header score (KD-2): how many cells of its detected header row match the mapping
 * dictionary, and how many non-empty data rows follow it.
 */
export function sheetScore(sheet: ParsedSheet) {
  const headerRow = detectHeaderRow(sheet.grid);
  const header = sheet.grid[headerRow - 1] ?? [];
  const known = header.filter((c) => typeof c === "string" && KNOWN.has(normalizeHeader(c))).length;
  let dataRows = 0;
  for (let i = headerRow; i < sheet.grid.length; i++) if ((sheet.grid[i] ?? []).some((c) => c !== null && c !== "")) dataRows++;
  return { headerRow, known, dataRows };
}

/**
 * Picks the sheet to import (KD-2): the highest header score, ties going to more data rows. A sheet
 * with fewer than 2 recognised headers or fewer than 2 data rows is never picked while another
 * qualifies, so a prose "instructions" sheet placed first loses to the guest list. The user can
 * always choose another sheet.
 */
export function pickSheet(sheets: ParsedSheet[]): { sheet: ParsedSheet; headerRow: number } | null {
  if (!sheets.length) return null;
  const scored = sheets.map((sheet, i) => ({ sheet, i, ...sheetScore(sheet) }));
  const qualifies = (s: (typeof scored)[number]) => s.known >= 2 && s.dataRows >= 2;
  const pool = scored.some(qualifies) ? scored.filter(qualifies) : scored.filter((s) => s.sheet.grid.length >= 2).length ? scored.filter((s) => s.sheet.grid.length >= 2) : scored;
  pool.sort((a, b) => b.known - a.known || b.dataRows - a.dataRows || a.i - b.i);
  return { sheet: pool[0].sheet, headerRow: pool[0].headerRow };
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
  if (rows.length > importMaxRows()) throw new ValidationError("errors.tooManyRows", { file: ["errors.tooManyRows"], max: [String(importMaxRows())] });
  return { headers, rows };
}
