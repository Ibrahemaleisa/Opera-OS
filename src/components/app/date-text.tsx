"use client";

import { formatDate, formatDateTime, formatDual, formatTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type DateInput = Date | string | number | null | undefined;
export type DateTextFormat = "date" | "datetime" | "time" | "dual";

function toDate(d: DateInput): Date | null {
  if (d === null || d === undefined || d === "") return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A formatted date/time that reads correctly in both scripts. The text is isolated from its
 * surroundings but keeps the page direction, so "23 أكتوبر 2026" stays day-month-year in Arabic.
 * Never wrap dates in `.ltr-nums` (that class forces LTR and scrambles Arabic month names);
 * `.ltr-nums` is for phone numbers, codes and IDs only.
 */
export function DateText({ value, format = "date", className }: { value: DateInput; format?: DateTextFormat; className?: string }) {
  const { fmt, dir } = useI18n();
  const d = toDate(value);
  if (!d) return <span className={className}>—</span>;
  const text = format === "time" ? formatTime(d, fmt) : format === "datetime" ? formatDateTime(d, fmt) : format === "dual" ? formatDual(d, fmt) : formatDate(d, fmt);
  return (
    <time dateTime={d.toISOString()} dir={dir} className={cn("tabular whitespace-nowrap [unicode-bidi:isolate]", className)}>
      {text}
    </time>
  );
}

/** "start – end" with each end isolated; the end can use a shorter format (e.g. time only on the same day). */
export function DateRangeText({ start, end, format = "datetime", endFormat, className }: { start: DateInput; end: DateInput; format?: DateTextFormat; endFormat?: DateTextFormat; className?: string }) {
  const { dir } = useI18n();
  return (
    <span dir={dir} className={cn("inline-flex flex-wrap items-baseline gap-x-1 [unicode-bidi:isolate]", className)}>
      <DateText value={start} format={format} />
      <span aria-hidden>–</span>
      <DateText value={end} format={endFormat ?? format} />
    </span>
  );
}

/**
 * Bidi isolate for mixed-direction text: user-entered names, titles and notes (`dir="auto"`, the
 * default) or codes, phone numbers and IDs that must read left-to-right (`dir="ltr"`).
 */
export function Bdi({ children, dir = "auto", className }: { children: React.ReactNode; dir?: "auto" | "ltr" | "rtl"; className?: string }) {
  return (
    <bdi dir={dir} className={className}>
      {children}
    </bdi>
  );
}
