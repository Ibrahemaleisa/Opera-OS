import { riyadhDayStart, type CalendarPref, type Locale } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Small layout pieces for read surfaces: a Field groups (tint, no border), a PanelHeader titles a
 * region over a hairline instead of boxing it.
 */

export function Field({ children, className, ...rest }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn("rounded-lg bg-brand-soft/60 p-4 dark:bg-brand-soft/40", className)} {...rest}>
      {children}
    </section>
  );
}

export function PanelHeader({ title, count, action, className, as: Tag = "h2" }: { title: React.ReactNode; count?: number; action?: React.ReactNode; className?: string; as?: "h2" | "h3" }) {
  return (
    <div className={cn("flex min-h-8 items-center justify-between gap-3 border-b pb-2", className)}>
      <Tag className="flex items-baseline gap-2 text-sm font-medium">
        {title}
        {count !== undefined && <span className="tabular text-xs font-normal text-muted-foreground">{count}</span>}
      </Tag>
      {action && <div className="flex shrink-0 items-center gap-2 text-xs">{action}</div>}
    </div>
  );
}

const DAY = 86_400_000;
const tag = (locale: Locale) => (locale === "ar" ? "ar-SA-u-nu-latn" : "en-GB");

/** "in 18 days", "tomorrow", "3 days ago" — counted in Riyadh calendar days. */
export function relativeDay(d: Date, now: Date, locale: Locale): string {
  const diff = Math.round((riyadhDayStart(d).getTime() - riyadhDayStart(now).getTime()) / DAY);
  const rtf = new Intl.RelativeTimeFormat(tag(locale), { numeric: "auto" });
  if (Math.abs(diff) < 45) return rtf.format(diff, "day");
  return rtf.format(Math.round(diff / 30), "month");
}

/** Age of something recent: minutes / hours under a day, then calendar days. */
export function relativeAge(d: Date, now: Date, locale: Locale): string {
  const sec = Math.round((d.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(tag(locale), { numeric: "auto" });
  if (Math.abs(sec) < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (Math.abs(sec) < 86_400) return rtf.format(Math.round(sec / 3600), "hour");
  return relativeDay(d, now, locale);
}

export type Fmt = { locale: Locale; calendar: CalendarPref };
