"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { CalendarDays, ChevronLeft, ChevronRight, FolderKanban, GanttChart, Kanban, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/app/data-table";
import { EmptyState, Section } from "@/components/app/page";
import { PriorityMark, StatusBadge } from "@/components/app/status-badge";
import { HealthPill } from "@/components/app/health";
import { HealthCell } from "@/components/operations/health";
import { StatusRing, type RingState } from "@/components/brand/status-ring";
import { formatDate, formatMoney, TIMEZONE } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { PortfolioProject } from "@/server/modules/projects/service";

type P = PortfolioProject;

/** Health v2 rows carry their reasons; finance reasons stay redacted unless the list says the viewer has finance. */
const financeVisible = (p: P) => Boolean((p as P & { financeVisible?: boolean }).financeVisible);

function projectRingState(p: P): RingState {
  if (p.status === "COMPLETED" || p.progress >= 1) return "complete";
  if (p.status === "ON_HOLD") return "paused";
  if (p.tasks.overdue > 0 || p.status === "AT_RISK") return "late";
  return p.progress > 0 ? "inProgress" : "notStarted";
}

export function ViewSwitch({ views, current }: { views: { key: string; label: string; icon: React.ReactNode }[]; current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  return (
    <div className="inline-flex rounded-md border bg-card p-0.5" role="tablist">
      {views.map((v) => (
        <button
          key={v.key}
          role="tab"
          aria-selected={current === v.key}
          onClick={() => {
            const q = new URLSearchParams(sp.toString());
            q.set("view", v.key);
            router.replace(`${pathname}?${q}`);
          }}
          className={cn("flex h-7 items-center gap-1.5 rounded px-2.5 text-xs text-muted-foreground transition-colors [&_svg]:size-3.5", current === v.key && "bg-secondary font-medium text-foreground")}
        >
          {v.icon}
          <span className="hidden sm:inline">{v.label}</span>
        </button>
      ))}
    </div>
  );
}

export function PortfolioViews({ orgSlug, projects, view, canCreate }: { orgSlug: string; projects: P[]; view: string; canCreate: boolean }) {
  const { m } = useI18n();
  const views = [
    { key: "list", label: m.projects.views.list, icon: <List /> },
    { key: "kanban", label: m.projects.views.kanban, icon: <Kanban /> },
    { key: "calendar", label: m.projects.views.calendar, icon: <CalendarDays /> },
    { key: "timeline", label: m.projects.views.timeline, icon: <GanttChart /> },
  ];
  if (!projects.length)
    return (
      <Section>
        <EmptyState icon={<FolderKanban />} title={m.projects.noProjects} body={m.projects.noProjectsBody} action={canCreate && <Button asChild size="sm"><Link href={`/o/${orgSlug}/projects/new`}>{m.projects.newProject}</Link></Button>} />
      </Section>
    );
  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex items-center justify-between gap-2">
        <ViewSwitch views={views} current={view} />
        <span className="tabular text-xs text-muted-foreground">{projects.length}</span>
      </div>
      {view === "kanban" ? <Board orgSlug={orgSlug} projects={projects} /> : view === "calendar" ? <MonthCalendarProjects orgSlug={orgSlug} projects={projects} /> : view === "timeline" ? <Timeline orgSlug={orgSlug} projects={projects} /> : <ListView orgSlug={orgSlug} projects={projects} />}
    </div>
  );
}

function ListView({ orgSlug, projects }: { orgSlug: string; projects: P[] }) {
  const { m, fmt } = useI18n();
  const router = useRouter();
  const columns = useMemo<ColumnDef<P, unknown>[]>(
    () => [
      { accessorKey: "code", header: m.projects.code, size: 110, cell: ({ getValue }) => <span className="ltr-nums font-mono text-xs text-muted-foreground">{getValue() as string}</span> },
      {
        accessorKey: "name",
        header: m.common.name,
        cell: ({ row }) => (
          <div className="min-w-[220px]">
            <Link href={`/o/${orgSlug}/projects/${row.original.id}`} className="font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>{row.original.name}</Link>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {row.original.workstreams.slice(0, 4).map((w) => (
                <span key={w.id} className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{w.name}</span>
              ))}
            </div>
          </div>
        ),
      },
      { id: "client", accessorFn: (r) => r.client?.name ?? "", header: m.projects.client, cell: ({ getValue }) => <span className="block min-w-28 text-[13px]">{getValue() as string}</span> },
      { accessorKey: "status", header: m.common.status, cell: ({ row }) => <StatusBadge status={row.original.status} label={m.enums.projectStatus[row.original.status]} /> },
      { accessorKey: "priority", header: m.common.priority, cell: ({ row }) => <PriorityMark priority={row.original.priority} label={m.enums.priority[row.original.priority]} /> },
      { id: "health", accessorFn: (r) => r.health.score, header: m.projects.health, cell: ({ row }) => <span className="block min-w-36"><HealthCell health={row.original.health} m={m} financeVisible={financeVisible(row.original)} /></span> },
      {
        id: "progress",
        accessorFn: (r) => r.progress,
        header: m.projects.progress,
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5 whitespace-nowrap">
            <StatusRing state={projectRingState(row.original)} value={row.original.progress} size={22} />
            <div className="min-w-0">
              <div className="tabular text-xs font-medium">{Math.round(row.original.progress * 100)}%</div>
              <div className="tabular text-[11px] text-muted-foreground">{interpolate(m.projects.tasksDone, { done: row.original.tasks.done, total: row.original.tasks.total })}{row.original.tasks.overdue > 0 && <span className="ms-1 text-danger">· {row.original.tasks.overdue} {m.common.overdue}</span>}</div>
            </div>
          </div>
        ),
      },
      { id: "event", accessorFn: (r) => r.eventStartAt ?? "", header: m.projects.eventDate, cell: ({ row }) => <span className="tabular text-xs">{formatDate(row.original.eventStartAt, fmt)}</span> },
      { id: "managers", accessorFn: (r) => r.managers.join(", "), header: m.projects.managers, cell: ({ getValue }) => <span className="text-xs">{getValue() as string}</span> },
      { id: "budget", accessorFn: (r) => Number(r.budgetAmount ?? 0), header: m.projects.budget, cell: ({ row }) => <span className="tabular text-xs">{row.original.budgetAmount ? formatMoney(row.original.budgetAmount, { ...fmt, compact: true }) : "—"}</span> },
    ],
    [m, fmt, orgSlug],
  );
  return (
    <Section>
      <DataTable data={projects} columns={columns} getRowId={(r) => r.id} onRowClick={(r) => router.push(`/o/${orgSlug}/projects/${r.id}`)} initialHidden={["budget"]} />
    </Section>
  );
}

const BOARD_COLUMNS = ["PLANNING", "ACTIVE", "AT_RISK", "ON_HOLD", "COMPLETED"] as const;

function ProjectCard({ orgSlug, p }: { orgSlug: string; p: P }) {
  const { m, fmt } = useI18n();
  return (
    <Link href={`/o/${orgSlug}/projects/${p.id}`} className="surface block p-3 transition-colors hover:border-primary/50">
      <div className="flex items-start justify-between gap-2">
        <span className="ltr-nums font-mono text-[10px] text-muted-foreground">{p.code}</span>
        <HealthPill health={p.health} compact financeVisible={financeVisible(p)} />
      </div>
      <div className="mt-1 text-[13px] leading-snug font-medium">{p.name}</div>
      {p.client && <div className="mt-0.5 text-xs text-muted-foreground">{p.client.name}</div>}
      <div className="mt-3 flex items-center gap-2">
        <StatusRing state={projectRingState(p)} value={p.progress} size={18} />
        <span className="tabular text-[11px] text-muted-foreground">{Math.round(p.progress * 100)}%</span>
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="tabular">{formatDate(p.eventStartAt ?? p.deadline, fmt)}</span>
        <PriorityMark priority={p.priority} label={m.enums.priority[p.priority]} />
      </div>
    </Link>
  );
}

function Board({ orgSlug, projects }: { orgSlug: string; projects: P[] }) {
  const { m } = useI18n();
  return (
    <div className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
      {BOARD_COLUMNS.map((s) => {
        const items = projects.filter((p) => p.status === s || (s === "PLANNING" && p.status === "DRAFT"));
        return (
          <div key={s} className="flex min-h-40 flex-col rounded-lg bg-muted/50 p-2">
            <div className="mb-2 flex items-center justify-between px-1">
              <StatusBadge status={s} label={m.enums.projectStatus[s]} />
              <span className="tabular text-xs text-muted-foreground">{items.length}</span>
            </div>
            <div className="grid gap-2">{items.map((p) => <ProjectCard key={p.id} orgSlug={orgSlug} p={p} />)}</div>
          </div>
        );
      })}
    </div>
  );
}

function ymd(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function MonthCalendar<T extends { id: string; name: string; start: string | Date | null; end?: string | Date | null; href: string; tone?: string }>({ items, locale }: { items: T[]; locale: "ar" | "en" }) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const startWeekday = (first.getUTCDay() + 1) % 7; // weeks start Saturday (Saudi convention)
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (Date | null)[] = [...Array(startWeekday).fill(null), ...Array.from({ length: days }, (_, i) => new Date(Date.UTC(year, month, i + 1, 9)))];
  while (cells.length % 7) cells.push(null);
  const weekdayFmt = new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { weekday: "short", timeZone: "UTC" });
  const weekdays = Array.from({ length: 7 }, (_, i) => weekdayFmt.format(new Date(Date.UTC(2026, 0, 3 + i))));
  const byDay = new Map<string, T[]>();
  for (const it of items) {
    if (!it.start) continue;
    const s = new Date(it.start);
    const e = it.end ? new Date(it.end) : s;
    for (let d = new Date(s); d <= e && byDay.size < 5000; d = new Date(d.getTime() + 86400_000)) {
      const k = ymd(d);
      (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(it);
    }
  }
  const Prev = locale === "ar" ? ChevronRight : ChevronLeft;
  const Next = locale === "ar" ? ChevronLeft : ChevronRight;
  return (
    <Section
      title={new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(cursor)}
      actions={
        <>
          <Button variant="ghost" size="icon-sm" onClick={() => setCursor(new Date(Date.UTC(year, month - 1, 1)))} aria-label="previous"><Prev /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setCursor(new Date(Date.UTC(year, month + 1, 1)))} aria-label="next"><Next /></Button>
        </>
      }
    >
      <div className="grid grid-cols-7 border-b text-center text-[11px] text-muted-foreground">
        {weekdays.map((w) => <div key={w} className="py-1.5">{w}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d, i) => {
          const list = d ? byDay.get(ymd(d)) ?? [] : [];
          const today = d && ymd(d) === ymd(new Date());
          return (
            <div key={i} className={cn("min-h-24 border-e border-b p-1 last:border-e-0", !d && "bg-muted/30")}>
              {d && <div className={cn("tabular mb-1 text-end text-[11px] text-muted-foreground", today && "font-medium text-primary")}>{d.getUTCDate()}</div>}
              <div className="grid gap-0.5">
                {list.slice(0, 3).map((it) => (
                  <Link key={it.id} href={it.href} className={cn("truncate rounded px-1 py-0.5 text-[10.5px] leading-tight", it.tone === "danger" ? "bg-danger-soft text-danger" : "bg-brand-soft text-primary")}>{it.name}</Link>
                ))}
                {list.length > 3 && <span className="px-1 text-[10px] text-muted-foreground">+{list.length - 3}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function MonthCalendarProjects({ orgSlug, projects }: { orgSlug: string; projects: P[] }) {
  const { locale } = useI18n();
  return <MonthCalendar locale={locale} items={projects.map((p) => ({ id: p.id, name: p.name, start: p.eventStartAt ?? p.deadline, end: p.eventEndAt, href: `/o/${orgSlug}/projects/${p.id}`, tone: p.health.level === "critical" ? "danger" : undefined }))} />;
}

export function GanttRows({ rows, locale }: { rows: { id: string; label: React.ReactNode; sub?: React.ReactNode; start: Date | null; end: Date | null; href?: string; tone?: "brand" | "danger" | "warning" | "muted"; progress?: number }[]; locale: "ar" | "en" }) {
  const [now] = useState(() => Date.now());
  const dated = rows.filter((r) => r.start || r.end);
  const min = Math.min(...dated.map((r) => (r.start ?? r.end)!.getTime()), now);
  const max = Math.max(...dated.map((r) => (r.end ?? r.start)!.getTime()), now + 7 * 86400_000);
  const span = Math.max(1, max - min);
  const pct = (t: number) => ((t - min) / span) * 100;
  const months: { label: string; left: number }[] = [];
  const d = new Date(min);
  d.setUTCDate(1);
  while (d.getTime() <= max) {
    if (d.getTime() >= min) months.push({ label: new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }).format(d), left: pct(d.getTime()) });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  const tones = { brand: "bg-primary", danger: "bg-danger", warning: "bg-warning", muted: "bg-muted-foreground/40" };
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="relative ms-[240px] h-7 border-b text-[10px] text-muted-foreground">
          {months.map((mo) => <span key={mo.label + mo.left} className="absolute top-2" style={{ insetInlineStart: `${mo.left}%` }}>{mo.label}</span>)}
        </div>
        {rows.map((r) => {
          const s = (r.start ?? r.end)?.getTime();
          const e = (r.end ?? r.start)?.getTime();
          return (
            <div key={r.id} className="flex h-10 items-center border-b last:border-0">
              <div className="w-[240px] shrink-0 truncate px-3 text-[13px]">
                {r.href ? <Link href={r.href} className="hover:text-primary">{r.label}</Link> : r.label}
                {r.sub && <div className="truncate text-[11px] text-muted-foreground">{r.sub}</div>}
              </div>
              <div className="relative h-full flex-1">
                <div className="absolute inset-y-0 w-px bg-danger/50" style={{ insetInlineStart: `${pct(now)}%` }} />
                {s !== undefined && e !== undefined && (
                  <div className={cn("absolute top-1/2 h-3.5 -translate-y-1/2 overflow-hidden rounded-sm opacity-80", tones[r.tone ?? "brand"])} style={{ insetInlineStart: `${pct(s)}%`, width: `${Math.max(0.6, pct(e) - pct(s))}%` }}>
                    {r.progress !== undefined && <div className="h-full bg-black/20" style={{ width: `${r.progress * 100}%` }} />}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Timeline({ orgSlug, projects }: { orgSlug: string; projects: P[] }) {
  const { locale, m } = useI18n();
  return (
    <Section>
      <GanttRows
        locale={locale}
        rows={projects.map((p) => ({
          id: p.id,
          label: p.name,
          sub: `${p.code}${p.client ? " · " + p.client.name : ""}`,
          start: p.startDate ? new Date(p.startDate) : null,
          end: p.deadline ? new Date(p.deadline) : p.eventStartAt ? new Date(p.eventStartAt) : null,
          href: `/o/${orgSlug}/projects/${p.id}`,
          tone: p.health.level === "critical" ? "danger" : p.health.level === "watch" ? "warning" : "brand",
          progress: p.progress,
        }))}
      />
      {!projects.some((p) => p.startDate || p.deadline) && <p className="p-6 text-center text-xs text-muted-foreground">{m.projects.unscheduled}</p>}
    </Section>
  );
}
