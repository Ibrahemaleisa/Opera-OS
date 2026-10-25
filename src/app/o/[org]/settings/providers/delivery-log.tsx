"use client";

import Link from "next/link";
import { FlaskConical, RotateCcw } from "lucide-react";
import { Section } from "@/components/app/page";
import { StatusBadge, type Tone } from "@/components/app/status-badge";
import { ActionButton } from "@/components/app/action-button";
import { ConfirmAction } from "@/components/app/confirm-action";
import { Button } from "@/components/ui/button";
import { DateText } from "@/components/app/date-text";
import { TimeAgo } from "@/components/app/time-ago";
import { useAction } from "@/hooks/use-action";
import { useI18n } from "@/lib/i18n/client";
import { interpolate } from "@/lib/i18n/define";
import { cn } from "@/lib/utils";
import { retryAllDeadAction, retryDeliveryAction } from "./actions";

export interface LogRow {
  id: string;
  createdAt: Date;
  to: string;
  channel: string;
  type: string;
  typeKey: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  link: string | null;
}

const TONE: Record<string, Tone> = { SENT: "success", SIMULATED: "muted", FAILED: "warning", DEAD: "danger", PENDING: "neutral", SENDING: "info", SUPPRESSED: "muted" };

/** Settings → Providers → "Delivery log": every notice e-mail with its status, attempts and errors. */
export function DeliveryLog({ orgSlug, rows, counts, mode, status }: { orgSlug: string; rows: LogRow[]; counts: Record<string, number>; mode: "LIVE" | "SIMULATION"; status: string }) {
  const { m, tk } = useI18n();
  const t = m.notif.log;
  const retry = useAction(retryDeliveryAction, { orgSlug, success: t.retried });
  const retryAll = useAction(retryAllDeadAction, { orgSlug, success: t.retried });
  const dead = counts.DEAD ?? 0;
  const base = `/o/${orgSlug}/settings/providers`;
  const attention = (counts.FAILED ?? 0) + dead;
  const label = (r: LogRow) =>
    r.status === "FAILED" ? interpolate(t.statuses.FAILED, { time: "" }).trim().replace(/[,،]\s*$/, "") : r.status === "DEAD" ? interpolate(t.statuses.DEAD, { n: r.attempts }) : (t.statuses as Record<string, string>)[r.status] ?? r.status;
  const typeLabel = (r: LogRow) => tk(r.typeKey, { title: "…", name: "…", count: "…", code: "…", days: "…", owner: "…" });
  return (
    <Section
      title={t.title}
      description={t.description}
      actions={
        dead > 0 ? (
          <ConfirmAction
            trigger={<Button size="sm" variant="outline"><RotateCcw className="size-3.5" /> {interpolate(t.retryAll, { n: dead })}</Button>}
            title={t.retryAllTitle}
            description={interpolate(t.retryAllBody, { n: dead })}
            confirmLabel={interpolate(t.retryAll, { n: dead })}
            onConfirm={() => retryAll.run({})}
          />
        ) : undefined
      }
    >
      {mode === "SIMULATION" && (
        <p className="flex items-center gap-2 border-b bg-violet-soft/40 px-4 py-2 text-xs text-violet" data-testid="email-simulated">
          <FlaskConical className="size-3.5" /> {t.simulatedBanner}
        </p>
      )}
      <nav className="flex gap-1 border-b px-4 py-2" aria-label={t.status}>
        {(["all", "attention"] as const).map((f) => (
          <Link key={f} href={f === "all" ? base : `${base}?status=attention`} className={cn("rounded-full border px-2.5 py-1 text-xs", status === f ? "border-primary bg-brand-soft text-primary" : "text-muted-foreground hover:text-foreground")} aria-current={status === f ? "page" : undefined}>
            {f === "all" ? t.all : t.attention}
            {f === "attention" && attention > 0 && <span className="ltr-nums ms-1 tabular">{attention}</span>}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t.empty}</p>
      ) : (
        <ul className="divide-y text-sm" data-testid="delivery-log">
          {rows.map((r) => (
            <li key={r.id} className="grid gap-1 px-4 py-2.5 md:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1.2fr)_auto_auto] md:items-center md:gap-3" data-testid="delivery-row" data-status={r.status}>
              <span className="order-3 text-xs text-muted-foreground md:order-none"><DateText value={r.createdAt} format="datetime" /></span>
              <span className="order-2 flex flex-wrap gap-x-2 text-xs text-muted-foreground md:order-none md:text-sm md:text-foreground">
                <bdi className="ltr-nums">{r.to}</bdi>
                <span className="text-muted-foreground">· {m.enums.channel[r.channel as keyof typeof m.enums.channel] ?? r.channel}</span>
              </span>
              <span className="order-1 flex min-w-0 flex-wrap items-center gap-2 md:order-none">
                <span className="truncate">{typeLabel(r)}</span>
                {r.link && <Link href={`/o/${orgSlug}${r.link}`} className="text-xs text-primary hover:underline">{t.open}</Link>}
              </span>
              <span className="order-1 flex items-center gap-2 md:order-none">
                <StatusBadge tone={TONE[r.status] ?? "neutral"} label={label(r)} />
                {r.status === "FAILED" && <span className="text-[11px] text-muted-foreground"><TimeAgo date={r.nextAttemptAt} /></span>}
                <span className="ltr-nums text-[11px] text-muted-foreground tabular" title={t.attempts}>×{r.attempts}</span>
              </span>
              <span className="order-4 md:order-none">
                {(r.status === "FAILED" || r.status === "DEAD") && (
                  <ActionButton size="xs" variant="outline" action={() => retry.run({ id: r.id })}>{t.retry}</ActionButton>
                )}
              </span>
              {r.lastError && (
                <details className="order-5 text-xs md:col-span-5">
                  <summary className="cursor-pointer text-muted-foreground">{t.errorDetail}</summary>
                  <p className="mt-1 text-muted-foreground">{t.errorExplain}</p>
                  <code className="mt-1 block rounded bg-muted/50 px-2 py-1 break-all" dir="ltr">{r.lastError}</code>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
