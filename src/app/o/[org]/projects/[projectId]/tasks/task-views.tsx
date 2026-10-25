"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertCircle, CalendarDays, CheckSquare, GanttChart, Kanban, List, Lock, Plus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/app/number-input";
import { DataTable } from "@/components/app/data-table";
import { Field, NativeSelect } from "@/components/app/field";
import { ProgressBar, Section } from "@/components/app/page";
import { PriorityMark, StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formObject } from "@/lib/form";
import { formatDate, parseRiyadhDate } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { StatusDef } from "@/server/modules/templates/definition";
import { GanttRows, MonthCalendar, ViewSwitch } from "../../portfolio-views";
import { bulkTasksAction, changeTaskStatusAction, createTaskAction } from "../../actions";

interface T {
  id: string; number: number; title: string; status: string; statusCategory: string; priority: string; workstreamId: string | null;
  owner: { id: string; name: string } | null; startAt: string | null; dueAt: string | null; completedAt: string | null; tags: string[];
  requiresApproval: boolean; clientVisible: boolean; escalatedAt: string | null; version: number; estimateMinutes: number | null; actualMinutes: number | null;
  subtasks: number; checklist: { done: number; total: number }; blockedByDeps: boolean;
}
interface WS { id: string; key: string; name: string; kind: string; color: string | null; statuses: StatusDef[] }

const CATEGORIES = ["TODO", "ACTIVE", "BLOCKED", "REVIEW", "DONE"] as const;

export function TaskViews({ orgSlug, projectId, view, workstreamId, tasks, workstreams, members, canCreate, canBulk }: { orgSlug: string; projectId: string; view: string; workstreamId: string; tasks: T[]; workstreams: WS[]; members: { id: string; name: string }[]; canCreate: boolean; canBulk: boolean }) {
  const { m, locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [createIn, setCreateIn] = useState<string | null>(null);
  const setParam = (k: string, v: string) => {
    const q = new URLSearchParams(sp.toString());
    if (v) q.set(k, v);
    else q.delete(k);
    router.replace(`${pathname}?${q}`);
  };
  const views = [
    { key: "board", label: m.projects.views.kanban, icon: <Kanban /> },
    { key: "list", label: m.projects.views.list, icon: <List /> },
    { key: "calendar", label: m.projects.views.calendar, icon: <CalendarDays /> },
    { key: "timeline", label: m.projects.views.timeline, icon: <GanttChart /> },
    { key: "workload", label: m.projects.views.workload, icon: <Users /> },
  ];
  const wsById = useMemo(() => new Map(workstreams.map((w) => [w.id, w])), [workstreams]);
  const href = (id: string) => `/o/${orgSlug}/tasks/${id}`;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ViewSwitch views={views} current={view} />
        <NativeSelect className="h-8 w-52" value={workstreamId} onChange={(e) => setParam("ws", e.target.value)} aria-label={m.tasks.workstream}>
          <option value="">{m.tasks.allWorkstreams}</option>
          {workstreams.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </NativeSelect>
        <NativeSelect className="h-8 w-44" value={sp.get("owner") ?? ""} onChange={(e) => setParam("owner", e.target.value)} aria-label={m.tasks.filterOwner}>
          <option value="">{m.tasks.filterOwner}: {m.common.all}</option>
          <option value="none">{m.common.unassigned}</option>
          {members.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NativeSelect>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={sp.get("overdue") === "1"} onChange={(e) => setParam("overdue", e.target.checked ? "1" : "")} /> {m.tasks.onlyOverdue}</label>
        <span className="tabular ms-auto text-xs text-muted-foreground">{tasks.length}</span>
        {canCreate && <Button size="sm" onClick={() => setCreateIn(workstreamId || workstreams[0]?.id || "")}><Plus /> {m.tasks.newTask}</Button>}
      </div>

      {view === "list" ? (
        <ListView tasks={tasks} wsById={wsById} href={href} orgSlug={orgSlug} projectId={projectId} canBulk={canBulk} members={members} />
      ) : view === "calendar" ? (
        <MonthCalendar locale={locale} items={tasks.filter((t) => t.dueAt).map((t) => ({ id: t.id, name: `#${t.number} ${t.title}`, start: t.dueAt, href: href(t.id), tone: t.statusCategory !== "DONE" && t.dueAt && new Date(t.dueAt) < new Date() ? "danger" : undefined }))} />
      ) : view === "timeline" ? (
        <Section>
          <GanttRows locale={locale} rows={tasks.map((t) => ({ id: t.id, label: `#${t.number} ${t.title}`, sub: [wsById.get(t.workstreamId ?? "")?.name, t.owner?.name].filter(Boolean).join(" · "), start: t.startAt ? new Date(t.startAt) : null, end: t.dueAt ? new Date(t.dueAt) : null, href: href(t.id), tone: t.statusCategory === "DONE" ? "muted" : t.statusCategory === "BLOCKED" ? "danger" : t.dueAt && new Date(t.dueAt) < new Date() ? "warning" : "brand" }))} />
        </Section>
      ) : view === "workload" ? (
        <Workload tasks={tasks} members={members} href={href} />
      ) : (
        <Board tasks={tasks} workstream={workstreamId ? wsById.get(workstreamId) ?? null : null} wsById={wsById} orgSlug={orgSlug} href={href} onAdd={canCreate ? (ws) => setCreateIn(ws) : undefined} />
      )}
      {createIn !== null && <CreateTaskDialog orgSlug={orgSlug} projectId={projectId} workstreams={workstreams} members={members} defaultWs={createIn} onClose={() => setCreateIn(null)} />}
    </div>
  );
}

function TaskCard({ t, href, ws, draggable, onDragStart }: { t: T; href: string; ws?: WS; draggable?: boolean; onDragStart?: (e: React.DragEvent) => void }) {
  const { m, fmt } = useI18n();
  const overdue = t.statusCategory !== "DONE" && t.dueAt && new Date(t.dueAt) < new Date();
  return (
    <Link href={href} draggable={draggable} onDragStart={onDragStart} data-testid="task-card" className={cn("surface block p-2.5 transition-colors hover:border-primary/50", t.escalatedAt && "border-s-2 border-s-danger")}>
      <div className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
        <span className="ltr-nums font-mono">#{t.number}</span>
        <span className="flex items-center gap-1">
          {t.blockedByDeps && <Lock className="size-3 text-warning" aria-label={m.tasks.blockedBy} />}
          {t.requiresApproval && <CheckSquare className="size-3 text-violet" />}
          {t.clientVisible && <span className="rounded bg-info-soft px-1 text-[9px] text-info">{m.common.clientVisible}</span>}
        </span>
      </div>
      <div className="mt-1 text-[13px] leading-snug">{t.title}</div>
      {ws && <div className="mt-1 flex items-center gap-1 text-[10.5px] text-muted-foreground"><span className="size-1.5 rounded-full" style={{ backgroundColor: ws.color ?? "currentColor" }} />{ws.name}</div>}
      <div className="mt-2 flex items-center justify-between gap-2">
        <PriorityMark priority={t.priority} label={m.enums.priority[t.priority as keyof typeof m.enums.priority]} />
        <div className="flex items-center gap-2 text-[11px]">
          {t.checklist.total > 0 && <span className="tabular text-muted-foreground">☑ {t.checklist.done}/{t.checklist.total}</span>}
          {t.dueAt && <span className={cn("tabular", overdue ? "font-medium text-danger" : "text-muted-foreground")}>{formatDate(t.dueAt, fmt)}</span>}
          {t.owner ? <span className="flex size-5 items-center justify-center rounded-full bg-secondary text-[9px] font-medium" title={t.owner.name}>{t.owner.name.slice(0, 2)}</span> : <span className="size-5 rounded-full border border-dashed" title={m.common.unassigned} />}
        </div>
      </div>
    </Link>
  );
}

function Board({ tasks, workstream, wsById, orgSlug, href, onAdd }: { tasks: T[]; workstream: WS | null; wsById: Map<string, WS>; orgSlug: string; href: (id: string) => string; onAdd?: (ws: string) => void }) {
  const { m, locale } = useI18n();
  const router = useRouter();
  const [over, setOver] = useState<string | null>(null);
  const move = useAction(changeTaskStatusAction, { orgSlug, success: false });
  // With a workstream selected the board shows its configured workflow; otherwise semantic categories.
  const columns = workstream
    ? workstream.statuses.map((s) => ({ key: s.key, label: locale === "en" ? s.en : s.ar, category: s.category, match: (t: T) => t.status === s.key }))
    : CATEGORIES.map((c) => ({ key: c, label: m.enums.statusCategory[c], category: c, match: (t: T) => t.statusCategory === c }));
  const onDrop = async (colKey: string, category: string, e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData("text/task");
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const ws = wsById.get(t.workstreamId ?? "");
    const target = workstream ? colKey : (ws?.statuses ?? []).find((s) => s.category === category)?.key ?? { TODO: "todo", ACTIVE: "in_progress", BLOCKED: "blocked", REVIEW: "review", DONE: "done" }[category];
    if (!target || target === t.status) return;
    const r = await move.run({ id, status: target, version: t.version });
    if (r.ok) router.refresh();
  };
  return (
    <div className="grid auto-cols-[minmax(270px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
      {columns.map((col) => {
        const items = tasks.filter(col.match);
        return (
          <div
            key={col.key}
            onDragOver={(e) => { e.preventDefault(); setOver(col.key); }}
            onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
            onDrop={(e) => onDrop(col.key, col.category, e)}
            className={cn("flex min-h-60 flex-col rounded-lg bg-muted/50 p-2 transition-colors", over === col.key && "bg-brand-soft ring-1 ring-primary/40")}
            data-testid={`column-${col.key}`}
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <StatusBadge status={col.category} label={col.label} />
              <span className="flex items-center gap-1">
                <span className="tabular text-xs text-muted-foreground">{items.length}</span>
                {onAdd && col.category === "TODO" && <Button variant="ghost" size="icon-xs" onClick={() => onAdd(workstream?.id ?? "")} aria-label={m.tasks.newTask}><Plus /></Button>}
              </span>
            </div>
            <div className="grid gap-2">
              {items.map((t) => (
                <TaskCard key={t.id} t={t} href={href(t.id)} ws={workstream ? undefined : wsById.get(t.workstreamId ?? "")} draggable onDragStart={(e) => e.dataTransfer.setData("text/task", t.id)} />
              ))}
              {items.length === 0 && <div className="rounded-md border border-dashed py-6 text-center text-[11px] text-muted-foreground">{m.tasks.dropHere}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ListView({ tasks, wsById, href, orgSlug, projectId, canBulk, members }: { tasks: T[]; wsById: Map<string, WS>; href: (id: string) => string; orgSlug: string; projectId: string; canBulk: boolean; members: { id: string; name: string }[] }) {
  const { m, fmt, locale } = useI18n();
  const router = useRouter();
  const bulk = useAction(bulkTasksAction, { orgSlug, success: false, onSuccess: (r) => toast.success(interpolate(m.tasks.bulkResult, { updated: r.updated, skipped: r.skipped.length })) });
  const columns = useMemo<ColumnDef<T, unknown>[]>(
    () => [
      { accessorKey: "number", header: "#", size: 60, cell: ({ getValue }) => <span className="ltr-nums font-mono text-xs text-muted-foreground">{getValue() as number}</span> },
      { accessorKey: "title", header: m.common.title, cell: ({ row }) => <Link href={href(row.original.id)} className="font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>{row.original.title}{row.original.blockedByDeps && <Lock className="ms-1 inline size-3 text-warning" />}{row.original.escalatedAt && <AlertCircle className="ms-1 inline size-3 text-danger" />}</Link> },
      { id: "ws", accessorFn: (r) => wsById.get(r.workstreamId ?? "")?.name ?? "", header: m.tasks.workstream, cell: ({ getValue }) => <span className="text-xs">{getValue() as string}</span> },
      { accessorKey: "statusCategory", header: m.common.status, cell: ({ row }) => { const ws = wsById.get(row.original.workstreamId ?? ""); const s = ws?.statuses.find((x) => x.key === row.original.status); return <StatusBadge status={row.original.statusCategory} label={s ? (locale === "en" ? s.en : s.ar) : row.original.status} />; } },
      { accessorKey: "priority", header: m.common.priority, cell: ({ row }) => <PriorityMark priority={row.original.priority} label={m.enums.priority[row.original.priority as keyof typeof m.enums.priority]} /> },
      { id: "owner", accessorFn: (r) => r.owner?.name ?? "", header: m.common.owner },
      { accessorKey: "dueAt", header: m.common.dueDate, cell: ({ row }) => <span className={cn("tabular text-xs", row.original.statusCategory !== "DONE" && row.original.dueAt && new Date(row.original.dueAt) < new Date() && "text-danger")}>{formatDate(row.original.dueAt, fmt)}</span> },
      { id: "check", accessorFn: (r) => (r.checklist.total ? r.checklist.done / r.checklist.total : -1), header: m.tasks.checklist, cell: ({ row }) => row.original.checklist.total ? <div className="w-20"><ProgressBar value={(row.original.checklist.done / row.original.checklist.total) * 100} /></div> : null },
      { id: "tags", accessorFn: (r) => r.tags.join(" "), header: m.tasks.tags, cell: ({ row }) => <span className="text-[11px] text-muted-foreground">{row.original.tags.join(", ")}</span> },
    ],
    [m, fmt, wsById, href, locale],
  );
  return (
    <Section>
      <DataTable
        data={tasks}
        columns={columns}
        getRowId={(r) => r.id}
        selectable={canBulk}
        onRowClick={(r) => router.push(href(r.id))}
        bulkActions={(rows, clear) => (
          <>
            <select className="h-6 rounded border bg-card px-1 text-xs" defaultValue="" onChange={(e) => { if (!e.target.value) return; bulk.run({ projectId, taskIds: rows.map((r) => r.id), set: { ownerId: e.target.value === "none" ? null : e.target.value } }).then(clear); e.target.value = ""; }} aria-label={m.tasks.bulkAssign}>
              <option value="">{m.tasks.bulkAssign}…</option>
              <option value="none">{m.common.unassigned}</option>
              {members.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="h-6 rounded border bg-card px-1 text-xs" defaultValue="" onChange={(e) => { if (!e.target.value) return; bulk.run({ projectId, taskIds: rows.map((r) => r.id), set: { status: e.target.value } }).then(clear); e.target.value = ""; }} aria-label={m.tasks.bulkStatus}>
              <option value="">{m.tasks.bulkStatus}…</option>
              {["todo", "in_progress", "blocked", "review", "done"].map((s, i) => <option key={s} value={s}>{m.enums.statusCategory[CATEGORIES[i]]}</option>)}
            </select>
            <select className="h-6 rounded border bg-card px-1 text-xs" defaultValue="" onChange={(e) => { if (!e.target.value) return; bulk.run({ projectId, taskIds: rows.map((r) => r.id), set: { priority: e.target.value as never } }).then(clear); e.target.value = ""; }} aria-label={m.tasks.bulkPriority}>
              <option value="">{m.tasks.bulkPriority}…</option>
              {Object.entries(m.enums.priority).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </>
        )}
      />
    </Section>
  );
}

function Workload({ tasks, members, href }: { tasks: T[]; members: { id: string; name: string }[]; href: (id: string) => string }) {
  const { m } = useI18n();
  const open = tasks.filter((t) => !["DONE", "CANCELLED"].includes(t.statusCategory));
  const rows = [...members, { id: "", name: m.common.unassigned }].map((p) => {
    const mine = open.filter((t) => (t.owner?.id ?? "") === p.id);
    return { ...p, tasks: mine, overdue: mine.filter((t) => t.dueAt && new Date(t.dueAt) < new Date()).length, minutes: mine.reduce((n, t) => n + (t.estimateMinutes ?? 0), 0) };
  }).filter((r) => r.tasks.length || r.id);
  const max = Math.max(1, ...rows.map((r) => r.tasks.length));
  return (
    <Section>
      <ul className="divide-y">
        {rows.map((r) => (
          <li key={r.id || "none"} className="grid gap-2 px-4 py-3 md:grid-cols-[200px_1fr_auto] md:items-center">
            <div className="text-[13px] font-medium">{r.name}</div>
            <div className="flex items-center gap-2">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full", r.tasks.length > 12 ? "bg-danger" : r.tasks.length > 7 ? "bg-warning" : "bg-primary")} style={{ width: `${(r.tasks.length / max) * 100}%` }} /></div>
              <span className="tabular w-8 text-end text-xs">{r.tasks.length}</span>
            </div>
            <div className="tabular flex gap-3 text-xs text-muted-foreground">
              {r.overdue > 0 && <span className="text-danger">{r.overdue} {m.common.overdue}</span>}
              <span>{Math.round(r.minutes / 60)}{m.projects.hours} {m.projects.estimate}</span>
            </div>
            {r.tasks.length > 0 && (
              <div className="flex flex-wrap gap-1 md:col-span-3">
                {r.tasks.slice(0, 12).map((t) => <Link key={t.id} href={href(t.id)} className="truncate rounded bg-muted px-1.5 py-0.5 text-[11px] hover:bg-brand-soft" style={{ maxWidth: 220 }}>#{t.number} {t.title}</Link>)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function CreateTaskDialog({ orgSlug, projectId, workstreams, members, defaultWs, onClose }: { orgSlug: string; projectId: string; workstreams: WS[]; members: { id: string; name: string }[]; defaultWs: string; onClose: () => void }) {
  const { m } = useI18n();
  const { run, pending, errorFor } = useAction(createTaskAction, { orgSlug, onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{m.tasks.newTask}</DialogTitle></DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const o = formObject(e.currentTarget);
            const freq = o.recurrence as string | null;
            run({ projectId, title: String(o.title), workstreamId: (o.workstreamId as string) || null, ownerId: (o.ownerId as string) || null, priority: o.priority as never, dueAt: parseRiyadhDate(o.dueAt as string, "17:00"), requiresApproval: !!o.requiresApproval, clientVisible: !!o.clientVisible, estimateMinutes: o.estimateMinutes ? Number(o.estimateMinutes) : null, tags: String(o.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean), recurrence: freq ? { freq: freq as never, interval: 1 } : null, description: (o.description as string) ?? null });
          }}
        >
          <Field label={m.common.title} error={errorFor("title")} required><Input name="title" required autoFocus data-testid="task-title" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={m.tasks.workstream}><NativeSelect name="workstreamId" defaultValue={defaultWs}>{workstreams.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</NativeSelect></Field>
            <Field label={m.common.assignee} error={errorFor("ownerId")}><NativeSelect name="ownerId"><option value="">{m.common.unassigned}</option>{members.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</NativeSelect></Field>
            <Field label={m.common.priority}><NativeSelect name="priority" defaultValue="MEDIUM">{Object.entries(m.enums.priority).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Field>
            <Field label={m.common.dueDate}><Input type="date" name="dueAt" dir="ltr" /></Field>
            <Field label={m.tasks.estimate}><NumberInput name="estimateMinutes" decimal={false} /></Field>
            <Field label={m.tasks.recurrence}><NativeSelect name="recurrence"><option value="">{m.tasks.recurNone}</option><option value="DAILY">{m.tasks.recurDaily}</option><option value="WEEKLY">{m.tasks.recurWeekly}</option><option value="MONTHLY">{m.tasks.recurMonthly}</option></NativeSelect></Field>
          </div>
          <Field label={m.tasks.tags}><Input name="tags" placeholder="vip, print" /></Field>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requiresApproval" /> {m.projects.requiresApproval}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="clientVisible" /> {m.common.clientVisible}</label>
          </div>
          <DialogFooter><Button type="submit" disabled={pending} data-testid="task-submit">{m.common.create}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

