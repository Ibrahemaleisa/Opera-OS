import Link from "next/link";
import { CalendarClock, CircleCheck, Mail, Workflow } from "lucide-react";
import { PageHeader, Section } from "@/components/app/page";
import { StatusBadge, type Tone } from "@/components/app/status-badge";
import { formatDateTime, formatRelative } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { cn } from "@/lib/utils";
import { guardPage } from "@/server/page-guard";
import { requirePageContext } from "@/server/request";
import { ForbiddenError } from "@/server/errors";
import { canViewSystemHealth, systemHealth, type HealthLevel } from "@/server/modules/recovery/service";
import { RetryOutboxButton } from "./retry-button";

export const dynamic = "force-dynamic";

const TONE: Record<HealthLevel | "unknown", Tone> = { ok: "success", info: "info", warning: "warning", critical: "danger", unknown: "muted" };

/** System health (BUSINESS_RULES §7.4): owners and operations directors. */
async function HealthPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  if (!canViewSystemHealth(ctx)) throw new ForbiddenError();
  const { m, fmt } = await getI18n();
  const t = m.health;
  const h = await systemHealth(ctx);
  const badge = (lvl: HealthLevel | "unknown") => <StatusBadge tone={TONE[lvl]} dot label={t.level[lvl]} />;
  const when = (d: Date | string | null) => (d ? <time dateTime={new Date(d).toISOString()} title={formatDateTime(d, fmt)} className="tabular">{formatRelative(d, fmt)}</time> : "—");
  const sched = h.scheduler;
  const schedStale = sched.state === "warning" || sched.state === "critical";
  const signals: { key: string; label: string; level: HealthLevel | "unknown"; value: React.ReactNode }[] = [
    { key: "scheduler", label: t.scheduler.title, level: sched.state, value: sched.lastTickAt ? when(sched.lastTickAt) : t.level.unknown },
    { key: "stalled", label: t.stalled.title, level: h.stalled.level, value: h.stalled.count },
    { key: "outbox", label: t.outbox.title, level: h.outbox.level, value: h.outbox.count },
    { key: "automation", label: t.automation.title, level: h.automation.level, value: h.automation.count },
    { key: "deliveries", label: t.deliveries.title, level: h.deliveries.level, value: h.deliveries.count },
    { key: "unknown", label: t.unknown.title, level: h.outcomeUnknown.level, value: h.outcomeUnknown.count },
    { key: "email", label: t.email.title, level: h.email.level, value: h.email.simulated ? m.common.simulation : "SMTP" },
  ];
  // the overall state first, in one line; details only where something needs attention
  const attention = signals.filter((s) => s.level === "warning" || s.level === "critical").length;
  const overall: HealthLevel = signals.some((s) => s.level === "critical") ? "critical" : attention ? "warning" : "ok";
  return (
    <>
      <PageHeader title={t.title} description={t.desc} meta={<span className="text-xs text-muted-foreground">{interpolate(t.checkedAt, { time: formatDateTime(h.checkedAt, fmt) })}</span>} />
      <div className="grid gap-4" data-testid="system-health">
        <p data-testid="health-overall" data-level={overall} className={cn("flex items-center gap-2 rounded-lg px-4 py-3 text-sm", overall === "ok" ? "bg-success-soft text-success" : overall === "critical" ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning")}>
          <CircleCheck className="size-4 shrink-0" aria-hidden />
          {overall === "ok" ? t.allClear : interpolate(t.attention, { n: attention })}
        </p>
        {(schedStale || sched.state === "unknown") && (
          <p role="status" data-testid="health-scheduler-alert" className={cn("flex items-start gap-2 px-1 text-sm", sched.state === "critical" ? "text-danger" : sched.state === "unknown" ? "text-muted-foreground" : "text-warning")}>
            <CalendarClock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{sched.state === "unknown" ? t.scheduler.never : interpolate(t.scheduler.stale, { n: sched.ageMinutes ?? 0 })}</span>
          </p>
        )}

        <Section>
          <ul className="divide-y">
            {signals.map((s) => (
              <li key={s.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm" data-testid={`health-signal-${s.key}`} data-level={s.level}>
                <span className="min-w-0 flex-1 font-medium">{s.label}</span>
                <span className="tabular text-muted-foreground">{s.value}</span>
                {badge(s.level)}
              </li>
            ))}
          </ul>
        </Section>

        {h.stalled.imports.length + h.stalled.sends.length > 0 && <Section title={t.stalled.title}>
          {(
            <ul className="divide-y" data-testid="health-stalled">
              {h.stalled.imports.map((b) => (
                <li key={b.id} className="grid gap-1 px-4 py-2.5 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{b.error === "import.stalled" ? t.stalled.importGaveUp : t.stalled.importPaused} · <bdi className="ltr-nums">{b.fileName}</bdi></div>
                    <div className="text-xs text-muted-foreground">{b.project ? <bdi>{b.project.code} · {b.project.name}</bdi> : null} · <span className="tabular">{interpolate(t.stalled.progress, { done: b.committedRows, total: b.totalRows })}</span></div>
                  </div>
                  <span className="text-xs text-muted-foreground">{when(b.updatedAt)}</span>
                  <Link className="text-xs text-primary hover:underline" href={`/o/${org}/projects/${b.projectId}/delivery/imports/${b.id}`}>{t.stalled.open}</Link>
                </li>
              ))}
              {h.stalled.sends.map((c) => (
                <li key={c.id} className="grid gap-1 px-4 py-2.5 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {c.state.late ? t.stalled.sendLate : c.state.stalled ? t.stalled.sendStalled : t.stalled.sendPaused} · <bdi>{c.name}</bdi>
                      {badge(c.state.late || c.state.stalled ? "critical" : "warning")}
                    </div>
                    <div className="text-xs text-muted-foreground">{c.project ? <bdi>{c.project.code} · {c.project.name}</bdi> : null}{c.state.late && c.scheduledAt ? <> · {formatDateTime(c.scheduledAt, fmt)}</> : null}</div>
                  </div>
                  <span className="text-xs text-muted-foreground">{when(c.updatedAt)}</span>
                  <Link className="text-xs text-primary hover:underline" href={`/o/${org}/projects/${c.projectId}/digital/${c.id}`}>{t.stalled.open}</Link>
                </li>
              ))}
            </ul>
          )}
        </Section>}

        {h.outcomeUnknown.rows.length > 0 && <Section title={t.unknown.title} description={t.unknown.desc}>
          {(
            <ul className="divide-y">
              {h.outcomeUnknown.rows.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-[13px]">
                  <span className="ltr-nums font-mono text-xs text-muted-foreground">{j.id.slice(-8)}</span>
                  <span>{m.enums.channel[j.channel]} · <bdi className="ltr-nums">{j.provider}</bdi></span>
                  <span className="ms-auto text-xs text-muted-foreground">{when(j.updatedAt)}</span>
                  {j.campaignId && j.projectId && <Link className="text-xs text-primary hover:underline" href={`/o/${org}/projects/${j.projectId}/digital/${j.campaignId}`}>{t.unknown.open}</Link>}
                </li>
              ))}
            </ul>
          )}
        </Section>}

        {h.outbox.rows.length > 0 && <Section title={t.outbox.title} description={t.outbox.desc}>
          {(
            <ul className="divide-y" data-testid="health-outbox">
              {h.outbox.rows.map((e) => (
                <li key={e.id} className="grid gap-1 px-4 py-2 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-3">
                  <div className="min-w-0">
                    <div className="ltr-nums font-mono text-xs">{e.type}</div>
                    {e.lastError && <div className="truncate text-xs text-danger" title={e.lastError}>{e.lastError}</div>}
                  </div>
                  <span className="text-xs text-muted-foreground">{interpolate(t.outbox.attempts, { n: e.attempts })} · {when(e.createdAt)}</span>
                  <RetryOutboxButton orgSlug={org} eventId={e.id} />
                </li>
              ))}
            </ul>
          )}
        </Section>}

        {h.automation.rows.length + h.deliveries.rows.length > 0 && <div className="grid gap-4 lg:grid-cols-2">
          <Section title={t.automation.title} description={t.automation.desc} actions={<Link className="flex items-center gap-1 text-xs text-primary hover:underline" href={`/o/${org}/settings/automation`}><Workflow className="size-3.5" aria-hidden />{t.automation.open}</Link>}>
            {h.automation.rows.length === 0 ? <p className="px-4 py-3 text-xs text-muted-foreground">{m.common.none}</p> : (
              <ul className="divide-y">
                {h.automation.rows.map((e) => (
                  <li key={e.id} className="px-4 py-2 text-[13px]">
                    <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{e.rule}</span><span className="text-xs text-muted-foreground">{when(e.createdAt)}</span></div>
                    {e.error && <div className="truncate text-xs text-danger" title={e.error}>{e.error}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={t.deliveries.title} description={<>{t.deliveries.desc}{h.deliveries.failing ? <> · {interpolate(t.deliveries.failing, { n: h.deliveries.failing })}</> : null}</>}>
            {h.deliveries.rows.length === 0 ? <p className="px-4 py-3 text-xs text-muted-foreground">{m.common.none}</p> : (
              <ul className="divide-y">
                {h.deliveries.rows.map((d) => (
                  <li key={d.id} className="px-4 py-2 text-[13px]">
                    <div className="flex items-center gap-2"><Mail className="size-3.5 text-muted-foreground" aria-hidden /><span className="ltr-nums min-w-0 flex-1 truncate font-mono text-xs">{d.template}</span><span className="text-xs text-muted-foreground">{when(d.createdAt)}</span></div>
                    {d.lastError && <div className="truncate text-xs text-danger" title={d.lastError}>{d.lastError}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>}

        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Mail className="size-3.5" aria-hidden />{h.email.simulated ? t.email.simulated : t.email.live}</p>
      </div>
    </>
  );
}

export default guardPage(HealthPage);
