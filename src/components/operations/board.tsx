import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/app/status-badge";
import { GapMark, NowDot } from "@/components/brand/gap-mark";
import { StatusRing } from "@/components/brand/status-ring";
import { formatDate, formatMoney, formatPercent, formatTime } from "@/lib/format";
import { interpolate, type Messages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { APPROVAL_DEFAULT_SLA_HOURS, HOUR_MS } from "@/server/modules/operations/criteria";
import { EXCEPTION_GROUP, type Awaiting, type ExceptionGroup, type ExceptionGroupKey, type ExceptionRow, type NextEvent, type OperationsBoard, type PortfolioRow } from "@/server/modules/operations/service";
import { HealthWord, reasonText, topReason } from "./health";
import { Field, PanelHeader, relativeAge, relativeDay, type Fmt } from "./primitives";

const VISIBLE_ROWS = 5;
/** On phones each group opens with fewer rows; the rest sit behind "Show all". */
const VISIBLE_ROWS_MOBILE = 2;

function Bdi({ children, className }: { children: React.ReactNode; className?: string }) {
  return <bdi className={className}>{children}</bdi>;
}

function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "danger" | "warning" | "brand" }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] leading-none whitespace-nowrap", tone === "danger" ? "bg-danger-soft text-danger" : tone === "warning" ? "bg-warning-soft text-warning" : tone === "brand" ? "bg-brand-soft text-primary" : "bg-secondary text-muted-foreground")}>
      {children}
    </span>
  );
}

function ActionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button asChild variant="outline" size="xs" className="h-7 px-2.5 text-xs">
      <Link href={href}>{children}</Link>
    </Button>
  );
}

// ── Needs you ──────────────────────────────────────────────────────────────

function approvalHref(base: string, a: Awaiting) {
  return a.entityType === "TASK" ? `${base}/tasks/${a.entityId}` : `${base}/projects/${a.projectId}/approvals`;
}

export function NeedsYou({ awaiting, now, m, fmt, base }: { awaiting: Awaiting[]; now: Date; m: Messages; fmt: Fmt; base: string }) {
  const t = m.ops;
  const row = (a: Awaiting) => {
    const due = a.dueAt ?? new Date(a.requestedAt.getTime() + APPROVAL_DEFAULT_SLA_HOURS * HOUR_MS);
    const late = due < now;
    const span = Math.max(1, due.getTime() - a.requestedAt.getTime());
    const elapsed = Math.min(1, Math.max(0, (now.getTime() - a.requestedAt.getTime()) / span));
    return (
      <li key={a.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5">
        <span className="rounded-full bg-card p-0.5"><StatusRing state={late ? "late" : "awaiting"} value={late ? 1 : elapsed} size={18} label={late ? t.pastDue : m.enums.approvalStatus.PENDING} /></span>
        <div className="min-w-0">
          <Link href={approvalHref(base, a)} className="block truncate text-[13px] font-medium hover:text-primary"><Bdi>{a.title}</Bdi></Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="ltr-nums">{a.projectCode}</span>
            <span className="truncate"><Bdi>{a.projectName}</Bdi></span>
            {a.requestedByName && <span>· {interpolate(t.requestedBy, { name: a.requestedByName })}</span>}
            <span>· {interpolate(t.requested, { when: relativeAge(a.requestedAt, now, fmt.locale) })}</span>
            {a.approverType === "CLIENT" && <Chip>{t.withClient}</Chip>}
            {late && <Chip tone="danger">{t.pastDue}</Chip>}
          </div>
        </div>
        <ActionLink href={approvalHref(base, a)}>{t.action.review}</ActionLink>
      </li>
    );
  };
  if (awaiting.length === 0) {
    // nothing to decide: one calm line instead of an empty box
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <StatusRing state="complete" size={16} />
        {t.needsYouNone}
      </p>
    );
  }
  return (
    <Field aria-labelledby="needs-you">
      <PanelHeader title={<span id="needs-you">{t.needsYou}</span>} count={awaiting.length} className="border-primary/15" />
      <ul className="divide-y divide-primary/10">{awaiting.slice(0, VISIBLE_ROWS).map(row)}</ul>
      {awaiting.length > VISIBLE_ROWS && (
        <details className="group">
          <summary className="cursor-pointer list-none pt-2 text-xs text-primary hover:underline group-open:hidden">{interpolate(t.showAll, { n: awaiting.length })}</summary>
          <ul className="divide-y divide-primary/10 border-t border-primary/10">{awaiting.slice(VISIBLE_ROWS).map(row)}</ul>
        </details>
      )}
    </Field>
  );
}

// ── Exceptions ─────────────────────────────────────────────────────────────

export const EXCEPTION_FILTERS: ("all" | ExceptionGroupKey)[] = ["all", "tasks", "decisions", "events", "delivery", "money"];

function rowDetail(r: ExceptionRow, m: Messages, fmt: Fmt, now: Date) {
  const t = m.ops;
  const chips: React.ReactNode[] = [];
  let when: string | null = null;
  const meta = r.meta;
  const money = (v: unknown) => formatMoney(typeof v === "number" ? v : null, { ...fmt, compact: true });
  const prio = (p: unknown) => (p === "CRITICAL" || p === "HIGH" ? chips.push(<Chip key="p" tone={p === "CRITICAL" ? "danger" : "warning"}>{m.enums.priority[p]}</Chip>) : null);
  switch (r.kind) {
    case "overdueTask":
      when = interpolate(t.due, { when: relativeDay(r.at!, now, fmt.locale) });
      prio(meta.priority);
      if (meta.clientVisible) chips.push(<Chip key="cv" tone="brand">{t.clientVisible}</Chip>);
      break;
    case "unownedTask":
      when = interpolate(t.dueOn, { when: relativeDay(r.at!, now, fmt.locale) });
      prio(meta.priority);
      break;
    case "blockedTask":
      chips.push(<Chip key="w" tone="warning"><Bdi>{interpolate(t.waitingOn, { n: meta.waitingOnNumber as number, title: String(meta.waitingOn) })}</Bdi>{Number(meta.more) > 0 ? ` ${interpolate(t.andMore, { n: Number(meta.more) })}` : ""}</Chip>);
      when = r.at ? interpolate(t.due, { when: relativeDay(r.at, now, fmt.locale) }) : null;
      break;
    case "approvalOverdue":
      when = interpolate(t.due, { when: relativeDay(r.at!, now, fmt.locale) });
      chips.push(<Chip key="a" tone={meta.approverType === "CLIENT" ? "neutral" : "warning"}>{meta.approverType === "CLIENT" ? t.withClient : t.internal}</Chip>);
      if (meta.defaultDue) chips.push(<Chip key="sla">{t.defaultSla}</Chip>);
      break;
    case "incident":
      when = relativeAge(r.at!, now, fmt.locale);
      chips.push(<Chip key="s" tone={meta.severity === "CRITICAL" || meta.severity === "HIGH" ? "danger" : "warning"}>{m.enums.severity[meta.severity as keyof typeof m.enums.severity]}</Chip>);
      chips.push(<Chip key="st">{m.enums.incidentStatus[meta.status as keyof typeof m.enums.incidentStatus]}</Chip>);
      if (meta.unacknowledged) chips.push(<Chip key="u" tone="danger">{t.unacked}</Chip>);
      break;
    case "readiness":
      when = meta.live ? t.live : relativeDay(r.at!, now, fmt.locale);
      chips.push(<Chip key="r" tone={Number(meta.total) === 0 ? "warning" : "neutral"}>{Number(meta.total) === 0 ? t.noChecklist : interpolate(t.readyOf, { ready: Number(meta.ready), total: Number(meta.total) })}</Chip>);
      if (Number(meta.issues) > 0) chips.push(<Chip key="i" tone="danger">{interpolate(t.issues, { n: Number(meta.issues) })}</Chip>);
      if (Number(meta.unowned) > 0) chips.push(<Chip key="o" tone="warning">{interpolate(t.unownedItems, { n: Number(meta.unowned) })}</Chip>);
      break;
    case "deliveryLate":
      when = meta.pastDeadline ? t.pastDeadline : r.at ? interpolate(t.deadline, { when: relativeAge(r.at, now, fmt.locale) }) : null;
      chips.push(<Chip key="n" tone="warning">{interpolate(t.invitations, { n: r.count ?? 0 })}</Chip>);
      break;
    case "deliveryFailed":
      chips.push(<Chip key="n" tone="warning">{interpolate(t.failedAttempts, { n: r.count ?? 0 })}</Chip>);
      break;
    case "milestone":
      when = interpolate(t.due, { when: relativeDay(r.at!, now, fmt.locale) });
      if (meta.blocked) chips.push(<Chip key="b" tone="danger">{t.blockedMilestone}</Chip>);
      break;
    case "overContract":
      chips.push(<Chip key="pc" tone="danger">{interpolate(t.plannedVsContract, { planned: money(meta.planned), contract: money(meta.contract) })}</Chip>);
      chips.push(<Chip key="mg" tone="danger">{interpolate(t.margin, { amount: money(meta.margin) })}</Chip>);
      break;
    case "overPlan":
      chips.push(<Chip key="l" tone="warning">{interpolate(t.lines, { n: r.count ?? 0 })}</Chip>);
      chips.push(<Chip key="o" tone="warning">{interpolate(t.overBy, { amount: money(meta.overrun) })}</Chip>);
      break;
    case "noApprover":
      chips.push(<Chip key="n" tone="warning">{t.stewardship.noApprover}</Chip>);
      break;
    case "selfApproved":
      if (r.owner) chips.push(<Chip key="s"><Bdi>{interpolate(t.stewardship.selfApprovedBy, { name: r.owner })}</Bdi></Chip>);
      when = r.at ? relativeAge(r.at, now, fmt.locale) : null;
      break;
    case "unownedAfterDeparture":
      if (meta.departed) chips.push(<Chip key="d" tone="warning"><Bdi>{interpolate(t.stewardship.departed, { name: String(meta.departed) })}</Bdi></Chip>);
      when = r.at ? interpolate(t.dueOn, { when: relativeDay(r.at, now, fmt.locale) }) : null;
      break;
    case "pmChanged":
    case "onHold":
      if (meta.reason) chips.push(<Chip key="r"><Bdi>{interpolate(t.stewardship.onHoldReason, { reason: String(meta.reason) })}</Bdi></Chip>);
      when = r.at ? relativeAge(r.at, now, fmt.locale) : null;
      break;
    case "stalledWork":
      chips.push(<Chip key="s" tone="warning">{interpolate(t.stewardship.stalled, { sends: Number(meta.sends), imports: Number(meta.imports) })}</Chip>);
      break;
    case "openCommitment":
      chips.push(<Chip key="c" tone="warning">{interpolate(t.stewardship.commitments, { pos: Number(meta.pos), expenses: Number(meta.expenses), workOrders: Number(meta.workOrders) })}</Chip>);
      if (Number(meta.amount) > 0) chips.push(<Chip key="a">{money(meta.amount)}</Chip>);
      break;
  }
  return { chips, when };
}

function ExceptionItem({ r, m, fmt, now, base, className }: { r: ExceptionRow; m: Messages; fmt: Fmt; now: Date; base: string; className?: string }) {
  const t = m.ops;
  const { chips, when } = rowDetail(r, m, fmt, now);
  const number = typeof r.meta.number === "number" ? `#${r.meta.number} ` : "";
  const ownerCell = r.owner ? <span className="truncate"><Bdi>{r.owner}</Bdi></span> : r.ownerExpected ? <span className="inline-flex items-center gap-1 text-warning"><GapMark size={12} />{t.noOwner}</span> : null;
  return (
    <li className={cn("grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 md:grid-cols-[auto_minmax(0,1fr)_9rem_8.5rem_auto]", className)}>
      {r.kind === "unownedTask" ? <GapMark size={14} label={t.noOwner} /> : <span className={cn("ms-[3px] size-2 shrink-0 rounded-full", r.tone === "danger" ? "bg-danger" : r.tone === "warning" ? "bg-warning" : "bg-muted-foreground/60")} aria-hidden />}
      <div className="min-w-0">
        <Link href={`${base}${r.href}`} className="block truncate text-[13px] font-medium hover:text-primary">
          {number && <span className="ltr-nums font-normal text-muted-foreground">{number.trim()}</span>}
          {number && " "}
          <Bdi>{r.kind === "stalledWork" ? t.stewardship.stalledTitle : r.title}</Bdi>
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="ltr-nums">{r.project.code}</span>
          {r.kind !== "overContract" && r.kind !== "overPlan" && <span className="max-w-[16rem] truncate"><Bdi>{r.project.name}</Bdi></span>}
          {chips}
          <span className="flex items-center gap-2 md:hidden">
            {ownerCell}
            {when && <span className={cn(r.tone === "danger" && "text-danger")}>{when}</span>}
          </span>
        </div>
      </div>
      <div className="hidden min-w-0 text-xs text-muted-foreground md:block">{ownerCell}</div>
      <div className={cn("hidden text-xs md:block", r.tone === "danger" ? "text-danger" : "text-muted-foreground")}>{when}</div>
      <ActionLink href={`${base}${r.href}`}>{t.action[r.action]}</ActionLink>
    </li>
  );
}

export function ExceptionsPanel({ groups, filter, m, fmt, now, base, hrefFor }: { groups: ExceptionGroup[]; filter: "all" | ExceptionGroupKey; m: Messages; fmt: Fmt; now: Date; base: string; hrefFor: (f: string) => string }) {
  const t = m.ops;
  const available = new Set(groups.map((g) => EXCEPTION_GROUP[g.kind]));
  const shown = groups.filter((g) => filter === "all" || EXCEPTION_GROUP[g.kind] === filter);
  const total = groups.reduce((a, g) => a + g.count, 0);
  const countFor = (f: string) => groups.filter((g) => f === "all" || EXCEPTION_GROUP[g.kind] === f).reduce((a, g) => a + g.count, 0);
  return (
    <section aria-labelledby="exceptions">
      <PanelHeader title={<span id="exceptions">{t.exceptions}</span>} count={total} />
      {total > 0 && (
        <nav className="-mx-1 mt-2 flex gap-1 overflow-x-auto pb-1" aria-label={t.exceptions}>
          {EXCEPTION_FILTERS.filter((f) => f === "all" || available.has(f)).map((f) => (
            <Link key={f} href={hrefFor(f)} aria-current={filter === f ? "page" : undefined} className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors", filter === f ? "border-primary bg-brand-soft font-medium text-primary" : "border-border text-muted-foreground hover:border-input hover:text-foreground")}>
              {t.filter[f]}
              <span className="tabular">{countFor(f)}</span>
            </Link>
          ))}
        </nav>
      )}
      {total === 0 ? (
        <div className="flex items-start gap-3 py-5">
          <StatusRing state="complete" size={20} />
          <div>
            <p className="text-sm font-medium">{t.exceptionsNone}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t.exceptionsNoneHint}</p>
          </div>
        </div>
      ) : (
        <div className="mt-2 grid gap-5">
          {shown.map((g) => (
            <div key={g.kind}>
              <h3 className="eyebrow flex items-center gap-2 border-b pb-1.5">
                {t.kind[g.kind]}
                <span className="tabular">{g.count}</span>
              </h3>
              <ul className="divide-y">
                {g.rows.slice(0, VISIBLE_ROWS).map((r, i) => <ExceptionItem key={`${r.kind}-${r.id}`} r={r} m={m} fmt={fmt} now={now} base={base} className={i >= VISIBLE_ROWS_MOBILE ? "max-md:hidden" : undefined} />)}
              </ul>
              {g.rows.length > VISIBLE_ROWS_MOBILE && (
                <details className={cn("group", g.rows.length <= VISIBLE_ROWS && "md:hidden")}>
                  <summary className="cursor-pointer list-none py-1.5 text-xs text-primary hover:underline group-open:hidden">{interpolate(t.showAll, { n: g.rows.length })}</summary>
                  <ul className="divide-y border-t">
                    {g.rows.slice(VISIBLE_ROWS_MOBILE).map((r, i) => <ExceptionItem key={`${r.kind}-${r.id}`} r={r} m={m} fmt={fmt} now={now} base={base} className={i + VISIBLE_ROWS_MOBILE < VISIBLE_ROWS ? "md:hidden" : undefined} />)}
                  </ul>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Next events ────────────────────────────────────────────────────────────

function readinessRing(r: NextEvent["readiness"], size: number, label: string) {
  if (r.total === 0) return <GapMark size={size} label={label} />;
  const v = r.ready / r.total;
  return <StatusRing state={r.ready >= r.total ? "complete" : r.issues > 0 ? "late" : "inProgress"} value={v} size={size} label={label} />;
}

export function NextEvents({ events, beyondWindow, now, m, fmt, base }: { events: NextEvent[]; beyondWindow: boolean; now: Date; m: Messages; fmt: Fmt; base: string }) {
  const t = m.ops;
  return (
    <section aria-labelledby="next-events">
      <PanelHeader title={<span id="next-events">{beyondWindow ? t.nextEventBeyond : t.nextEvents}</span>} action={!beyondWindow && events.length > 0 ? <span className="text-muted-foreground">{t.nextEventsHint}</span> : null} />
      {events.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{t.noEvents}</p>
      ) : (
        <ol className="relative mt-3 ms-1 border-s ps-5">
          <li className="relative pb-4">
            <span className="absolute -start-[25.5px] top-1"><NowDot /></span>
            <span className="text-xs font-medium text-primary">{t.today}</span>
            <span className="ms-2 text-xs text-muted-foreground">{formatDate(now, fmt)}</span>
          </li>
          {events.map((e) => {
            const label = e.readiness.total === 0 ? t.noChecklist : interpolate(t.readyOf, { ready: e.readiness.ready, total: e.readiness.total });
            return (
              <li key={e.id} className="relative pb-5 last:pb-0">
                <span className="absolute -start-[30px] top-0.5 rounded-full bg-background p-0.5">{e.live ? <NowDot live /> : readinessRing(e.readiness, 16, label)}</span>
                <Link href={`${base}/projects/${e.project.id}/events/${e.id}`} className="block text-[13px] font-medium hover:text-primary"><Bdi>{e.name}</Bdi></Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className={cn("font-medium", e.live ? "text-danger" : "text-foreground")}>{e.live ? t.live : relativeDay(e.startsAt, now, fmt.locale)}</span>
                  <span className="tabular">{formatDate(e.startsAt, fmt)} · {formatTime(e.startsAt, fmt)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Chip tone={e.readiness.total === 0 ? "warning" : e.readiness.issues ? "danger" : "neutral"}>{label}</Chip>
                  {e.readiness.issues > 0 && <Chip tone="danger">{interpolate(t.issues, { n: e.readiness.issues })}</Chip>}
                  <span className="ltr-nums text-[11px] text-muted-foreground">{e.project.code}</span>
                </div>
                {e.live && <Link href={`${base}/events`} className="mt-1 inline-block text-xs text-primary hover:underline">{t.liveView}</Link>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ── Portfolio ──────────────────────────────────────────────────────────────

function progressRing(p: PortfolioRow) {
  const { done, total } = p.health.progress;
  const v = total ? done / total : 0;
  const state = total > 0 && done >= total ? "complete" : p.health.level === "critical" ? "late" : p.health.level === "watch" ? "awaiting" : done > 0 ? "inProgress" : "notStarted";
  return <StatusRing state={state} value={v} size={24} />;
}

export function PortfolioList({ rows, now, m, fmt, base }: { rows: PortfolioRow[]; now: Date; m: Messages; fmt: Fmt; base: string }) {
  const t = m.ops;
  return (
    <section aria-labelledby="portfolio">
      <PanelHeader title={<span id="portfolio">{t.portfolio}</span>} count={rows.length} action={<Link href={`${base}/projects`} className="text-primary hover:underline">{m.common.view}</Link>} />
      {rows.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{t.portfolioNone}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((p) => {
            const top = topReason(p.health);
            const gaps: React.ReactNode[] = [];
            if (p.gaps.unowned) gaps.push(<span key="u" className="inline-flex items-center gap-1"><GapMark size={12} />{interpolate(t.gap.unowned, { n: p.gaps.unowned })}</span>);
            if (p.gaps.noEventDate) gaps.push(<span key="e" className="inline-flex items-center gap-1"><GapMark size={12} />{t.gap.noEventDate}</span>);
            if (p.gaps.noManager) gaps.push(<span key="m" className="inline-flex items-center gap-1"><GapMark size={12} />{t.gap.noManager}</span>);
            if (p.gaps.noClient) gaps.push(<span key="c" className="inline-flex items-center gap-1"><GapMark size={12} />{t.gap.noClient}</span>);
            return (
              <li key={p.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 py-3 md:grid-cols-[auto_minmax(0,1.5fr)_8rem_minmax(0,1.5fr)] md:items-center">
                <div className="row-span-3 pt-0.5 md:row-span-1 md:pt-0">{progressRing(p)}</div>
                <div className="min-w-0">
                  <Link href={`${base}/projects/${p.id}`} className="block truncate text-[13px] font-medium hover:text-primary"><Bdi>{p.name}</Bdi></Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="ltr-nums">{p.code}</span>
                    {p.clientName && <span className="truncate"><Bdi>{p.clientName}</Bdi></span>}
                    <span className="tabular">· {interpolate(t.tasksDone, { done: p.health.progress.done, total: p.health.progress.total })}</span>
                    {p.managers.length > 0 && <span className="truncate">· <Bdi>{p.managers.join("، ")}</Bdi></span>}
                  </div>
                </div>
                <div className="text-xs">
                  {p.eventStartAt ? (
                    <>
                      <div className="font-medium text-foreground">{relativeDay(p.eventStartAt, now, fmt.locale)}</div>
                      <div className="tabular text-muted-foreground">{formatDate(p.eventStartAt, fmt)}</div>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-warning"><GapMark size={12} />{t.gap.noEventDate}</span>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <HealthWord health={p.health} m={m} />
                    {top && <span className="truncate text-xs text-muted-foreground">{reasonText(top, m, p.financeVisible)}</span>}
                  </div>
                  {gaps.length > 0 && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-warning">{gaps}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Signals ────────────────────────────────────────────────────────────────

export function SignalStrip({ signals, m, fmt, base }: { signals: NonNullable<OperationsBoard["signals"]>; m: Messages; fmt: Fmt; base: string }) {
  const t = m.ops.signal;
  const money = (v: number) => formatMoney(v, { ...fmt, compact: true });
  const items: { key: string; text: string; href: string; tone?: string }[] = [];
  if (signals.delivery && signals.delivery.total) items.push({ key: "d", text: interpolate(t.delivery, { pct: formatPercent(signals.delivery.delivered / signals.delivery.total, fmt), done: signals.delivery.delivered, total: signals.delivery.total }), href: `${base}/delivery` });
  if (signals.rsvp) items.push({ key: "r", text: interpolate(t.rsvp, { pct: formatPercent(signals.rsvp.responded / signals.rsvp.sent, fmt) }), href: `${base}/digital` });
  if (signals.finance) {
    const f = signals.finance;
    if (f.withContract) items.push({ key: "c", text: interpolate(t.contract, { amount: money(f.contract) }), href: `${base}/finance` });
    items.push({ key: "p", text: interpolate(t.planned, { amount: money(f.planned) }), href: `${base}/finance` });
    items.push({ key: "cm", text: interpolate(t.committed, { amount: money(f.committed) }), href: `${base}/finance` });
    items.push({ key: "a", text: interpolate(t.actual, { amount: money(f.actual) }), href: `${base}/finance` });
    if (f.withContract) items.push({ key: "m", text: interpolate(t.forecastMargin, { amount: money(f.contract - f.forecast) }), href: `${base}/finance`, tone: f.contract - f.forecast < 0 ? "text-danger" : undefined });
  }
  if (!items.length) return null;
  return (
    <section aria-label={m.ops.signals} className="flex flex-wrap items-center gap-x-1 gap-y-2 border-t pt-4 text-xs text-muted-foreground">
      <span className="eyebrow me-2">{m.ops.signals}</span>
      {items.map((i, idx) => (
        <span key={i.key} className="inline-flex items-center">
          {idx > 0 && <span className="mx-2 text-border" aria-hidden>|</span>}
          <Link href={i.href} className={cn("tabular whitespace-nowrap hover:text-foreground hover:underline", i.tone)}>{i.text}</Link>
        </span>
      ))}
    </section>
  );
}

// ── Setup ──────────────────────────────────────────────────────────────────

export function SetupChecklist({ setup, m, base }: { setup: NonNullable<OperationsBoard["setup"]>; m: Messages; base: string }) {
  const t = m.ops.setup;
  if (!setup.canCreate) return <p className="max-w-xl text-sm text-muted-foreground">{t.noPermission}</p>;
  const steps = [
    { key: "client", done: setup.steps.client, href: `${base}/settings/clients`, allowed: setup.canDirectory },
    { key: "venue", done: setup.steps.venue, href: `${base}/settings/venues`, allowed: setup.canDirectory },
    { key: "team", done: setup.steps.team, href: `${base}/settings/members`, allowed: setup.canMembers },
    { key: "providers", done: setup.steps.providers, href: `${base}/settings/providers`, allowed: setup.canProviders },
  ] as const;
  return (
    <Field className="max-w-3xl p-5">
      <h2 className="text-base font-medium">{t.title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t.body}</p>
      <ol className="mt-4 divide-y divide-primary/10">
        {steps.filter((s) => s.allowed).map((s) => (
          <li key={s.key} className="flex min-h-12 items-center gap-3 py-2">
            <span className="rounded-full bg-card p-0.5">{s.done ? <StatusRing state="complete" size={20} label={t.done} /> : <StatusRing state="notStarted" size={20} />}</span>
            <span className={cn("flex-1 text-sm", s.done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{t[s.key]}</span>
            {s.done ? <StatusBadge tone="success" label={t.done} /> : <ActionLink href={s.href}>{t.go}</ActionLink>}
          </li>
        ))}
        <li className="flex min-h-12 items-center gap-3 py-2">
          <span className="rounded-full bg-card p-0.5"><StatusRing state="notStarted" size={20} /></span>
          <span className="flex-1 text-sm font-medium">{t.project}</span>
          <Button asChild size="sm"><Link href={`${base}/projects/new`}>{t.go}</Link></Button>
        </li>
      </ol>
    </Field>
  );
}
