/**
 * CSV/XLSX formula-injection protection (OWASP "CSV Injection").
 * Any cell starting with = + - @ TAB or CR is prefixed with a single quote.
 */
export function neutralizeFormula(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    const s = neutralizeFormula(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens UTF-8 Arabic correctly
  return "﻿" + [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}
