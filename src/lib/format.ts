export type Locale = "ar" | "en";
export type CalendarPref = "gregory" | "islamic-umalqura";

export const TIMEZONE = "Asia/Riyadh";

// Latin digits are used in both locales for dense operational screens (IDs, phones,
// counts read across languages). Override per org with settings.arabicDigits.
function tag(locale: Locale, calendar: CalendarPref = "gregory") {
  const base = locale === "ar" ? "ar-SA" : "en-GB";
  return `${base}-u-nu-latn-ca-${calendar === "islamic-umalqura" ? "islamic-umalqura" : "gregory"}`;
}

export interface FormatOpts {
  locale: Locale;
  calendar?: CalendarPref;
}

type DateInput = Date | string | number | null | undefined;
function toDate(d: DateInput): Date | null {
  if (d === null || d === undefined || d === "") return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(d: DateInput, o: FormatOpts): string {
  const date = toDate(d);
  if (!date) return "—";
  return new Intl.DateTimeFormat(tag(o.locale, o.calendar), { timeZone: TIMEZONE, day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function formatDateTime(d: DateInput, o: FormatOpts): string {
  const date = toDate(d);
  if (!date) return "—";
  return new Intl.DateTimeFormat(tag(o.locale, o.calendar), {
    timeZone: TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: o.locale === "ar",
  }).format(date);
}

export function formatTime(d: DateInput, o: FormatOpts): string {
  const date = toDate(d);
  if (!date) return "—";
  return new Intl.DateTimeFormat(tag(o.locale), { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: o.locale === "ar" }).format(date);
}

/** Both calendars side by side, e.g. "12 Nov 2026 · 21 Jumada I 1448" */
export function formatDual(d: DateInput, o: FormatOpts): string {
  const date = toDate(d);
  if (!date) return "—";
  return `${formatDate(date, { ...o, calendar: "gregory" })} · ${formatDate(date, { ...o, calendar: "islamic-umalqura" })}`;
}

// ICU builds disagree on bidi marks around Arabic numbers (Node on the server adds a leading
// U+200F to compact currency, browsers don't), which breaks hydration. Numbers render inside
// isolated runs anyway, so the marks are dropped.
const BIDI_MARKS = /[\u200e\u200f\u061c]/g;
const clean = (s: string) => s.replace(BIDI_MARKS, "");

// Compact notation is not taken from ICU: builds disagree on it ("SAR 96K" in Node, "SAR 96k"
// in Chromium), which broke hydration. The scale and suffix are applied here, deterministically,
// and only standard (stable) number formatting comes from Intl.
const COMPACT_UNITS: { size: number; en: string; ar: string }[] = [
  { size: 1e9, en: "B", ar: " مليار" },
  { size: 1e6, en: "M", ar: " مليون" },
  { size: 1e3, en: "K", ar: " ألف" },
];

/** Splits a number into a scaled value (≤ 1 decimal) and its compact suffix, e.g. 102800 → 102.8 + K. */
export function compactScale(n: number, locale: Locale): { value: number; suffix: string } {
  const abs = Math.abs(n);
  for (let i = 0; i < COMPACT_UNITS.length; i++) {
    const u = COMPACT_UNITS[i];
    if (abs < u.size) continue;
    const scaled = Math.round((n / u.size) * 10) / 10;
    // 999,960 rounds to 1000K: promote to the next unit up instead
    if (Math.abs(scaled) >= 1000 && i > 0) {
      const up = COMPACT_UNITS[i - 1];
      return { value: Math.round((n / up.size) * 10) / 10, suffix: up[locale] };
    }
    return { value: scaled, suffix: u[locale] };
  }
  return { value: Math.round(n * 10) / 10, suffix: "" };
}

export function formatMoney(amount: number | string | { toString(): string } | null | undefined, o: FormatOpts & { currency?: string; compact?: boolean }): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const n = typeof amount === "number" ? amount : Number(amount.toString());
  if (!Number.isFinite(n)) return "—";
  if (!o.compact) {
    return clean(new Intl.NumberFormat(tag(o.locale), { style: "currency", currency: o.currency ?? "SAR", maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(n));
  }
  const { value, suffix } = compactScale(n, o.locale);
  const parts = new Intl.NumberFormat(tag(o.locale), { style: "currency", currency: o.currency ?? "SAR", maximumFractionDigits: 1, minimumFractionDigits: 0 }).formatToParts(value);
  let last = -1;
  parts.forEach((p, i) => { if (p.type === "integer" || p.type === "fraction") last = i; });
  return clean(parts.map((p, i) => (i === last ? p.value + suffix : p.value)).join(""));
}

export function formatNumber(n: number | null | undefined, o: FormatOpts & { maximumFractionDigits?: number } = { locale: "ar" }): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return clean(new Intl.NumberFormat(tag(o.locale), { maximumFractionDigits: o.maximumFractionDigits ?? 0 }).format(n));
}

export function formatPercent(ratio: number | null | undefined, o: FormatOpts): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return clean(new Intl.NumberFormat(tag(o.locale), { style: "percent", maximumFractionDigits: 1 }).format(ratio));
}

export function formatRelative(d: DateInput, o: FormatOpts, now = new Date()): string {
  const date = toDate(d);
  if (!date) return "—";
  const diffSec = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(tag(o.locale), { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diffSec), "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / 86400), "day");
  return formatDate(date, o);
}

/** Start of the given day in Riyadh, as a UTC Date. */
export function riyadhDayStart(d = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return new Date(`${parts}T00:00:00+03:00`);
}

/** Parses an <input type="date"> / "YYYY-MM-DD" value as a Riyadh-local date. */
export function parseRiyadhDate(value: string | null | undefined, time = "00:00"): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T${time}:00+03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Formats a Date as YYYY-MM-DD in Riyadh, for date inputs. */
export function toDateInput(d: DateInput): string {
  const date = toDate(d);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function toDateTimeInput(d: DateInput): string {
  const date = toDate(d);
  if (!date) return "";
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}

export function parseRiyadhDateTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value.length === 16 ? value + ":00" : value}+03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
