import Link from "next/link";
import { GapMark, NowDot } from "@/components/brand/gap-mark";
import { StatusRing, type RingState } from "@/components/brand/status-ring";
import { formatDate, formatTime } from "@/lib/format";
import { interpolate, type Messages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { BUCKETS, type Bucket, type Commitment, type MyCommitments } from "@/server/modules/operations/service";
import { Field, PanelHeader, relativeAge, relativeDay, type Fmt } from "./primitives";

const TASK_RING: Record<string, RingState> = { TODO: "notStarted", ACTIVE: "inProgress", REVIEW: "awaiting", BLOCKED: "paused" };
const READINESS_RING: Record<string, RingState> = { PENDING: "notStarted", IN_PROGRESS: "inProgress", ISSUE: "late" };

function Mark({ c, m }: { c: Commitment; m: Messages }) {
  if (c.kind === "task") return <StatusRing state={c.bucket === "overdue" ? "late" : TASK_RING[c.status] ?? "notStarted"} size={16} label={m.enums.statusCategory[c.status as keyof typeof m.enums.statusCategory]} />;
  if (c.kind === "readiness") return <StatusRing state={READINESS_RING[c.status] ?? "notStarted"} size={16} />;
  if (c.kind === "incident") return <span className={cn("ms-[3px] size-2.5 shrink-0 rounded-full", c.level === "CRITICAL" || c.level === "HIGH" ? "bg-danger" : "bg-warning")} aria-hidden />;
  return <span className="ms-[3px] size-2.5 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />;
}

function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "danger" | "warning" | "brand" }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] leading-none whitespace-nowrap", tone === "danger" ? "bg-danger-soft text-danger" : tone === "warning" ? "bg-warning-soft text-warning" : tone === "brand" ? "bg-brand-soft text-primary" : "bg-secondary text-muted-foreground")}>{children}</span>;
}

function dueText(c: Commitment, now: Date, m: Messages, fmt: Fmt) {
  if (!c.due) return null;
  if (c.kind === "incident") return relativeAge(c.due, now, fmt.locale);
  if (c.bucket === "overdue") return interpolate(m.ops.due, { when: relativeDay(c.due, now, fmt.locale) });
  if (c.bucket === "today") return `${m.ops.today} ${formatTime(c.due, fmt)}`;
  return `${relativeDay(c.due, now, fmt.locale)} · ${formatDate(c.due, fmt)}`;
}

export function CommitmentRow({ c, now, m, fmt, base }: { c: Commitment; now: Date; m: Messages; fmt: Fmt; base: string }) {
  const t = m.ops.my;
  const when = dueText(c, now, m, fmt);
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <Mark c={c} m={m} />
      <div className="min-w-0">
        <Link href={`${base}${c.href}`} className="block truncate text-[13px] font-medium hover:text-primary">
          {c.number !== null && <span className="ltr-nums font-normal text-muted-foreground">#{c.number}</span>}
          {c.number !== null && " "}
          <bdi>{c.title}</bdi>
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {c.kind !== "task" && <Chip>{t.kind[c.kind]}</Chip>}
          {c.project && <span className="ltr-nums">{c.project.code}</span>}
          {c.context && <span className="max-w-[14rem] truncate"><bdi>{c.context}</bdi></span>}
          {(c.level === "HIGH" || c.level === "CRITICAL") && <Chip tone={c.level === "CRITICAL" ? "danger" : "warning"}>{m.enums.priority[c.level]}</Chip>}
          {c.clientVisible && <Chip tone="brand">{m.ops.clientVisible}</Chip>}
          {c.blockedBy.length > 0 && <Chip tone="warning"><bdi>{interpolate(t.blockedBy, { n: c.blockedBy[0].number, title: c.blockedBy[0].title })}</bdi></Chip>}
          {c.awaitingApproval && <Chip>{t.awaitingApproval}</Chip>}
          {when && <span className={cn("sm:hidden", c.bucket === "overdue" && "text-danger")}>{when}</span>}
        </div>
      </div>
      {when && <span className={cn("hidden text-end text-xs whitespace-nowrap sm:block", c.bucket === "overdue" ? "text-danger" : "text-muted-foreground")}>{when}</span>}
    </li>
  );
}

export function Queue({ items, now, m, fmt, base }: { items: Commitment[]; now: Date; m: Messages; fmt: Fmt; base: string }) {
  const t = m.ops.my;
  const by = (b: Bucket) => items.filter((i) => i.bucket === b);
  const urgent = by("overdue").length + by("today").length;
  const next = items.find((i) => i.due && i.due >= now);
  return (
    <div className="grid gap-6">
      {urgent === 0 && items.length > 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <StatusRing state="complete" size={16} />
          {t.allClear}
          {next && <span>· {interpolate(t.nextDue, { title: next.title, when: relativeDay(next.due!, now, fmt.locale) })}</span>}
        </p>
      )}
      {BUCKETS.filter((b) => by(b).length).map((b) => (
        <section key={b} aria-labelledby={`bucket-${b}`}>
          <h2 id={`bucket-${b}`} className={cn("eyebrow flex items-center gap-2 border-b pb-1.5", b === "overdue" && "!text-danger")}>
            {b === "none" && <GapMark size={12} />}
            {t.bucket[b]}
            <span className="tabular">{by(b).length}</span>
          </h2>
          <ul className="divide-y">{by(b).map((c) => <CommitmentRow key={`${c.kind}-${c.id}`} c={c} now={now} m={m} fmt={fmt} base={base} />)}</ul>
        </section>
      ))}
    </div>
  );
}

export function OnSiteToday({ items, now, m, fmt, base }: { items: MyCommitments["onSite"]; now: Date; m: Messages; fmt: Fmt; base: string }) {
  const t = m.ops.my;
  if (!items.length) return null;
  return (
    <section aria-labelledby="on-site">
      <PanelHeader title={<span id="on-site">{t.onSite}</span>} count={items.length} />
      <ol className="relative mt-3 ms-1 border-s ps-5">
        {items.map((x) => {
          const live = x.at <= now && x.until >= now;
          return (
            <li key={`${x.kind}-${x.id}`} className="relative pb-4 last:pb-0">
              <span className="absolute -start-[25.5px] top-1">{live ? <NowDot live /> : <span className="block size-2.5 rounded-full border-2 border-muted-foreground/50 bg-background" />}</span>
              <Link href={`${base}${x.href}`} className="block text-[13px] font-medium hover:text-primary"><bdi>{x.title}</bdi></Link>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span className="tabular text-foreground">{formatTime(x.at, fmt)}</span>
                <span>{interpolate(t.until, { time: formatTime(x.until, fmt) })}</span>
                <span>· {t.kind[x.kind]}</span>
                {x.eventName && <span className="truncate">· <bdi>{x.eventName}</bdi></span>}
                {x.location && <span className="truncate">· <bdi>{x.location}</bdi></span>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function ProjectGaps({ gaps, m, base }: { gaps: MyCommitments["gaps"]; m: Messages; base: string }) {
  const t = m.ops.my;
  if (!gaps.length) return null;
  return (
    <section aria-labelledby="gaps">
      <PanelHeader title={<span id="gaps" className="inline-flex items-center gap-2"><GapMark size={14} />{t.gaps}</span>} />
      <ul className="divide-y">
        {gaps.map((g) => (
          <li key={g.project.id} className="py-2.5">
            <Link href={`${base}/projects/${g.project.id}`} className="block truncate text-[13px] font-medium hover:text-primary"><bdi>{g.project.name}</bdi></Link>
            <div className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
              {g.unowned > 0 && (
                <span>
                  {interpolate(t.gapUnowned, { n: g.unowned })}
                  {g.unownedSoon > 0 && <span className="text-warning"> · {interpolate(t.gapUnownedSoon, { n: g.unownedSoon })}</span>}
                </span>
              )}
              {g.undatedMilestones > 0 && <span>{interpolate(t.gapUndated, { n: g.undatedMilestones })}</span>}
              {g.noEventDate && <span>{t.gapNoEvent}</span>}
            </div>
            {g.unowned > 0 && <Link href={`${base}/projects/${g.project.id}/tasks?view=workload`} className="mt-1 inline-block text-xs text-primary hover:underline">{t.assignOwners}</Link>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function WaitingOnOthers({ items, now, m, fmt, base }: { items: Commitment[]; now: Date; m: Messages; fmt: Fmt; base: string }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="waiting">
      <PanelHeader title={<span id="waiting">{m.ops.my.waiting}</span>} count={items.length} />
      <ul className="divide-y">{items.map((c) => <CommitmentRow key={c.id} c={c} now={now} m={m} fmt={fmt} base={base} />)}</ul>
    </section>
  );
}

export function OwnedRisks({ risks, m, base }: { risks: MyCommitments["risks"]; m: Messages; base: string }) {
  if (!risks.length) return null;
  return (
    <section aria-labelledby="risks">
      <PanelHeader title={<span id="risks">{m.ops.my.risks}</span>} count={risks.length} />
      <ul className="divide-y">
        {risks.map((r) => (
          <li key={r.id} className="flex items-center gap-3 py-2.5">
            <span className={cn("tabular inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-medium", r.score >= 12 ? "bg-danger-soft text-danger" : r.score >= 6 ? "bg-warning-soft text-warning" : "bg-secondary text-muted-foreground")}>{r.score}</span>
            <div className="min-w-0">
              <Link href={`${base}${r.href}`} className="block truncate text-[13px] font-medium hover:text-primary"><bdi>{r.title}</bdi></Link>
              {r.project && <span className="ltr-nums text-xs text-muted-foreground">{r.project.code}</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export { Field };
