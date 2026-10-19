"use client";

import { formatDateTime, formatRelative } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";

/** Relative time that tolerates server/client clock differences (no hydration mismatch). */
export function TimeAgo({ date, className }: { date: string | Date | null | undefined; className?: string }) {
  const { fmt } = useI18n();
  if (!date) return <span className={className}>—</span>;
  return (
    <time suppressHydrationWarning dateTime={new Date(date).toISOString()} title={formatDateTime(date, fmt)} className={className}>
      {formatRelative(date, fmt)}
    </time>
  );
}
