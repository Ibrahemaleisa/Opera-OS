"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Plus, Radio, SkipForward, TimerReset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Breadcrumbs, EmptyState, ProgressBar, Section, Stat } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { NativeSelect } from "@/components/app/field";
import { FormDialog, enumOptions, type FieldDef } from "@/components/app/form-dialog";
import { useAction } from "@/hooks/use-action";
import { formatDateTime, formatPercent, formatTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { getEventWorkspace } from "@/server/modules/events/service";
import {
  reportIncidentAction,
  saveLogisticsAction,
  saveReadinessAction,
  saveRunItemAction,
  saveSessionAction,
  saveShiftAction,
  saveSpeakerAction,
  setReadinessStatusAction,
  setRunItemStatusAction,
  setShiftStatusAction,
  updateEventAction,
  updateIncidentAction,
} from "@/app/o/[org]/events/actions";

type W = Awaited<ReturnType<typeof getEventWorkspace>>;
type Dialog = { kind: "event" | "session" | "speaker" | "cue" | "shift" | "readiness" | "incident" | "logistics"; values?: Record<string, unknown> | null } | null;

const TABS = ["overview", "agenda", "speakers", "runOfShow", "staff", "readiness", "incidents", "logistics"] as const;
type Tab = (typeof TABS)[number];

export function EventWorkspace({ orgSlug, data }: { orgSlug: string; data: W }) {
  const { m, fmt, dir } = useI18n();
  const t = m.events;
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>((TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "overview");
  const [dialog, setDialog] = useState<Dialog>(null);
  const e = data.event;
  const close = () => setDialog(null);
  const people = useMemo(() => data.people.map((p) => ({ value: p.id, label: p.name })), [data.people]);
  const nameOf = (id: string | null) => data.people.find((p) => p.id === id)?.name ?? t.unassigned;

  const saveEvent = useAction(updateEventAction, { orgSlug, onSuccess: close });
  const saveSession = useAction(saveSessionAction, { orgSlug, onSuccess: close });
  const saveSpeaker = useAction(saveSpeakerAction, { orgSlug, onSuccess: close });
  const saveCue = useAction(saveRunItemAction, { orgSlug, onSuccess: close });
  const cue = useAction(setRunItemStatusAction, { orgSlug, success: false });
  const saveShift = useAction(saveShiftAction, { orgSlug, onSuccess: close });
  const shift = useAction(setShiftStatusAction, { orgSlug, success: false });
  const saveReady = useAction(saveReadinessAction, { orgSlug, onSuccess: close });
  const ready = useAction(setReadinessStatusAction, { orgSlug, success: false });
  const report = useAction(reportIncidentAction, { orgSlug, onSuccess: close });
  const incident = useAction(updateIncidentAction, { orgSlug, success: false });
  const saveLog = useAction(saveLogisticsAction, { orgSlug, onSuccess: close });

  const go = (next: Tab) => {
    setTab(next);
    const u = new URL(window.location.href);
    u.searchParams.set("tab", next);
    router.replace(u.pathname + u.search, { scroll: false });
  };

  const openIncidents = data.incidents.filter((i) => ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"].includes(i.status));
  const onSite = data.shifts.filter((s) => s.status === "CHECKED_IN").length;
  const arrived = (data.guests.ARRIVED ?? 0) + (data.guests.SEATED ?? 0);
  const expected = arrived + (data.guests.EXPECTED ?? 0) + (data.guests.CONFIRMED ?? 0);
  const can = data.canManage;

  const fields: Record<NonNullable<Dialog>["kind"], FieldDef[]> = {
    event: [
      { name: "name", label: m.common.nameAr, required: true, wide: true },
      { name: "nameEn", label: m.common.nameEn, ltr: true, wide: true },
      { name: "startsAt", label: t.starts, type: "datetime", required: true },
      { name: "endsAt", label: t.ends, type: "datetime", required: true },
      { name: "phase", label: t.phase, type: "select", options: enumOptions(m.enums.eventPhase) },
      { name: "venueId", label: t.venue, type: "select", empty: "—", options: data.venues.map((v) => ({ value: v.id, label: `${v.name} — ${v.city}` })) },
      { name: "expectedGuests", label: t.expectedGuests, type: "number", min: 0 },
      { name: "brief", label: t.brief, type: "textarea" },
    ],
    session: [
      { name: "title", label: m.common.title, required: true, wide: true },
      { name: "kind", label: m.common.type, type: "select", options: enumOptions(t.sessionKind) },
      { name: "status", label: m.common.status, type: "select", options: enumOptions(t.sessionStatus) },
      { name: "startsAt", label: t.starts, type: "datetime", required: true },
      { name: "endsAt", label: t.ends, type: "datetime", required: true },
      { name: "room", label: t.room },
    ],
    speaker: [
      { name: "name", label: m.common.name, required: true },
      { name: "nameEn", label: m.common.nameEn, ltr: true },
      { name: "title", label: m.common.title },
      { name: "organizationName", label: m.projects.client },
      { name: "topic", label: t.topic, wide: true },
      { name: "phone", label: m.common.phone, type: "tel" },
      { name: "email", label: m.common.email, type: "email" },
      { name: "status", label: m.common.status, type: "select", options: enumOptions(t.speakerStatus) },
      { name: "needs", label: t.needs, type: "textarea" },
    ],
    cue: [
      { name: "title", label: m.common.title, required: true, wide: true },
      { name: "startsAt", label: t.starts, type: "datetime", required: true },
      { name: "durationMin", label: t.duration, type: "number", min: 0 },
      { name: "ownerId", label: t.owner, type: "select", empty: t.unassigned, options: people },
      { name: "location", label: t.location },
      { name: "cue", label: t.cue, type: "textarea" },
    ],
    shift: [
      { name: "role", label: t.role, required: true },
      { name: "userId", label: t.person, type: "select", empty: t.unassigned, options: people },
      { name: "startsAt", label: t.starts, type: "datetime", required: true },
      { name: "endsAt", label: t.ends, type: "datetime", required: true },
      { name: "location", label: t.location, wide: true },
    ],
    readiness: [
      { name: "label", label: t.label, required: true, wide: true },
      { name: "category", label: t.category, type: "select", options: enumOptions(t.readinessCategory) },
      { name: "ownerId", label: t.owner, type: "select", empty: t.unassigned, options: people },
      { name: "dueAt", label: t.due, type: "datetime" },
      { name: "note", label: t.note, type: "textarea" },
    ],
    incident: [
      { name: "title", label: m.common.title, required: true, wide: true },
      { name: "severity", label: t.severity, type: "select", options: enumOptions(m.enums.severity) },
      { name: "location", label: t.location },
      { name: "description", label: t.description, type: "textarea" },
    ],
    logistics: [
      { name: "name", label: m.common.name, required: true, wide: true },
      { name: "category", label: t.category, type: "select", options: enumOptions(t.logisticsCategory) },
      { name: "status", label: m.common.status, type: "select", options: enumOptions(t.logisticsStatus) },
      { name: "quantity", label: t.quantity, type: "number", min: 0 },
      { name: "neededBy", label: t.neededBy, type: "datetime" },
      { name: "notes", label: m.common.notes, type: "textarea" },
    ],
  };

  const submit = (kind: NonNullable<Dialog>["kind"], v: Record<string, unknown>) => {
    const id = (dialog?.values?.id as string | undefined) ?? undefined;
    if (kind === "event") saveEvent.run({ ...v, id: e.id } as never);
    if (kind === "session") saveSession.run({ ...v, id, eventId: e.id, speakerIds: (dialog?.values?.speakerIds as string[]) ?? [] } as never);
    if (kind === "speaker") saveSpeaker.run({ ...v, id, eventId: e.id } as never);
    if (kind === "cue") saveCue.run({ ...v, id, eventId: e.id, durationMin: v.durationMin ?? 15 } as never);
    if (kind === "shift") saveShift.run({ ...v, id, eventId: e.id } as never);
    if (kind === "readiness") saveReady.run({ ...v, id, eventId: e.id } as never);
    if (kind === "incident") report.run({ ...v, projectId: data.project.id, eventId: e.id } as never);
    if (kind === "logistics") saveLog.run({ ...v, id, projectId: data.project.id, eventId: e.id, quantity: v.quantity ?? 1 } as never);
  };
  const pendingAny = saveEvent.pending || saveSession.pending || saveSpeaker.pending || saveCue.pending || saveShift.pending || saveReady.pending || report.pending || saveLog.pending;
  const errorFor = (f: string) => saveEvent.errorFor(f) ?? saveSession.errorFor(f) ?? saveShift.errorFor(f) ?? saveSpeaker.errorFor(f) ?? saveCue.errorFor(f) ?? saveReady.errorFor(f) ?? report.errorFor(f) ?? saveLog.errorFor(f);
  const dialogTitle: Record<NonNullable<Dialog>["kind"], string> = { event: e.name, session: t.newSession, speaker: t.newSpeaker, cue: t.newCue, shift: t.newShift, readiness: t.addItem, incident: t.reportIncident, logistics: t.newLogistics };
  const addBtn = (kind: NonNullable<Dialog>["kind"], label: string, testId?: string) => (can || (kind === "incident" && data.canReport)) && <Button size="sm" onClick={() => setDialog({ kind })} data-testid={testId}><Plus /> {label}</Button>;

  return (
    <div className="grid gap-4">
      <Breadcrumbs dir={dir} items={[{ label: m.nav.events, href: `/o/${orgSlug}/projects/${data.project.id}/events` }, { label: e.name }]} />
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium">{e.name}</h2>
        <StatusBadge status={e.phase} label={m.enums.eventPhase[e.phase]} />
        {data.live && <span className="flex items-center gap-1 rounded bg-danger-soft px-2 py-0.5 text-xs text-danger"><Radio className="size-3 animate-pulse" /> {t.live}</span>}
        <span className="ltr-nums text-xs text-muted-foreground">{formatDateTime(e.startsAt, fmt)} → {formatTime(e.endsAt, fmt)}</span>
        <div className="ms-auto flex gap-2">
          {data.canReport && <Button size="sm" variant="outline" className="text-danger" onClick={() => setDialog({ kind: "incident" })} data-testid="report-incident"><AlertTriangle /> {t.reportIncident}</Button>}
          {can && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "event", values: e as unknown as Record<string, unknown> })}>{m.common.edit}</Button>}
        </div>
      </div>

      <nav className="-mb-px flex gap-1 overflow-x-auto border-b" role="tablist">
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => go(k)} data-testid={`event-tab-${k}`} className={cn("flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 text-[13px] text-muted-foreground hover:text-foreground", tab === k && "border-primary font-medium text-foreground")}>
            {t.tabs[k]}
            {k === "incidents" && openIncidents.length > 0 && <span className="tabular rounded-full bg-danger px-1.5 text-[10px] text-white">{openIncidents.length}</span>}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t.readinessScore} value={formatPercent(data.readinessScore, fmt)} tone={data.readinessScore === 1 ? "success" : data.readiness.some((r) => r.status === "ISSUE") ? "danger" : "default"} />
            <Stat label={t.openIncidents} value={openIncidents.length} tone={openIncidents.some((i) => i.severity === "CRITICAL" || i.severity === "HIGH") ? "danger" : "default"} />
            <Stat label={t.staffOnSite} value={`${onSite}/${data.shifts.length}`} />
            <Stat label={t.guestsArrived} value={`${arrived}/${expected}`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title={t.tabs.runOfShow}>
              <div className="grid gap-2 p-4 text-sm">
                <div className="rounded-lg border-s-4 border-danger bg-danger-soft/40 p-3"><div className="text-[11px] text-muted-foreground">{t.nowLive}</div><div className="font-medium" data-testid="cue-now">{data.current?.title ?? "—"}</div></div>
                <div className="rounded-lg border-s-4 border-info bg-info-soft/40 p-3"><div className="text-[11px] text-muted-foreground">{t.upNext}</div><div className="font-medium">{data.next ? `${formatTime(data.next.startsAt, fmt)} · ${data.next.title}` : "—"}</div></div>
              </div>
            </Section>
            <Section title={t.readiness}>
              <ul className="grid gap-2 p-4">
                {Object.entries(t.readinessCategory).map(([k, label]) => {
                  const items = data.readiness.filter((r) => r.category === k);
                  if (!items.length) return null;
                  const r = items.filter((x) => x.status === "READY").length;
                  const issue = items.some((x) => x.status === "ISSUE");
                  return <li key={k} className="grid grid-cols-[110px_1fr_40px] items-center gap-2 text-xs"><span>{label}</span><ProgressBar value={(r / items.length) * 100} tone={issue ? "danger" : r === items.length ? "success" : "brand"} /><span className="tabular text-end text-muted-foreground">{r}/{items.length}</span></li>;
                })}
              </ul>
            </Section>
          </div>
          {e.brief && <Section title={t.brief}><p className="p-4 text-sm whitespace-pre-wrap">{e.brief}</p></Section>}
        </div>
      )}

      {tab === "agenda" && (
        <Section title={`${t.tabs.agenda} (${data.sessions.length})`} actions={addBtn("session", t.newSession)}>
          {data.sessions.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
            <ul className="divide-y">
              {data.sessions.map((s) => (
                <li key={s.id} className={cn("grid gap-1 px-4 py-3 md:grid-cols-[140px_1fr_140px_120px] md:items-center", can && "cursor-pointer hover:bg-muted/40")} onClick={() => can && setDialog({ kind: "session", values: s as unknown as Record<string, unknown> })}>
                  <span className="ltr-nums text-xs text-muted-foreground">{formatTime(s.startsAt, fmt)} – {formatTime(s.endsAt, fmt)}</span>
                  <div><div className="text-[13px] font-medium">{s.title}</div><div className="text-[11px] text-muted-foreground">{t.sessionKind[s.kind as keyof typeof t.sessionKind]}{s.speakerIds.length ? ` · ${s.speakerIds.map((id) => data.speakers.find((x) => x.id === id)?.name).filter(Boolean).join("، ")}` : ""}</div></div>
                  <span className="text-xs">{s.room ?? "—"}</span>
                  <StatusBadge status={s.status} label={t.sessionStatus[s.status as keyof typeof t.sessionStatus]} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {tab === "speakers" && (
        <Section title={`${t.speakers} (${data.speakers.length})`} actions={addBtn("speaker", t.newSpeaker)}>
          {data.speakers.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
            <ul className="divide-y">
              {data.speakers.map((s) => (
                <li key={s.id} className={cn("grid gap-1 px-4 py-3 md:grid-cols-[1fr_1fr_160px_140px] md:items-center", can && "cursor-pointer hover:bg-muted/40")} onClick={() => can && setDialog({ kind: "speaker", values: s as unknown as Record<string, unknown> })}>
                  <div><div className="text-[13px] font-medium">{s.name}</div><div className="text-[11px] text-muted-foreground">{[s.title, s.organizationName].filter(Boolean).join(" · ")}</div></div>
                  <span className="text-xs">{s.topic ?? "—"}</span>
                  <span className="ltr-nums text-xs text-muted-foreground">{s.phone ?? s.email ?? "—"}</span>
                  <StatusBadge status={s.status === "DECLINED" ? "REJECTED" : s.status === "BRIEFED" ? "DONE" : s.status === "INVITED" ? "PENDING" : "ACTIVE"} label={t.speakerStatus[s.status as keyof typeof t.speakerStatus]} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {tab === "runOfShow" && (
        <Section title={`${t.tabs.runOfShow} (${data.runOfShow.length})`} actions={addBtn("cue", t.newCue)}>
          {data.runOfShow.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
            <ul className="divide-y">
              {data.runOfShow.map((r) => (
                <li key={r.id} data-status={r.status} className={cn("grid gap-2 px-4 py-3 md:grid-cols-[90px_1fr_140px_auto] md:items-center", r.status === "GO" && "bg-danger-soft/40", ["DONE", "SKIPPED"].includes(r.status) && "opacity-60")}>
                  <span className="ltr-nums text-sm font-medium">{formatTime(r.startsAt, fmt)} <span className="text-[11px] text-muted-foreground">+{r.durationMin}′</span></span>
                  <button className="text-start" onClick={() => can && setDialog({ kind: "cue", values: r as unknown as Record<string, unknown> })}><div className="text-[13px] font-medium">{r.title}</div>{r.cue && <div className="text-[11px] whitespace-pre-wrap text-muted-foreground">{r.cue}</div>}</button>
                  <span className="text-xs text-muted-foreground">{nameOf(r.ownerId)}{r.location ? ` · ${r.location}` : ""}</span>
                  <div className="flex items-center gap-1">
                    <StatusBadge status={r.status === "GO" ? "LIVE" : r.status === "STANDBY" ? "SCHEDULED" : r.status} label={t.runStatus[r.status as keyof typeof t.runStatus]} />
                    {can && r.status === "PENDING" && <Button size="xs" variant="outline" onClick={() => cue.run({ id: r.id, status: "STANDBY", expected: r.status })}><TimerReset /> {t.standby}</Button>}
                    {can && ["PENDING", "STANDBY"].includes(r.status) && <Button size="xs" onClick={() => cue.run({ id: r.id, status: "GO", expected: r.status })} data-testid={`cue-go-${r.id}`}>{t.go}</Button>}
                    {can && r.status === "GO" && <Button size="xs" variant="outline" onClick={() => cue.run({ id: r.id, status: "DONE", expected: r.status })}><CheckCircle2 /> {t.done}</Button>}
                    {can && ["PENDING", "STANDBY"].includes(r.status) && <Button size="xs" variant="ghost" onClick={() => cue.run({ id: r.id, status: "SKIPPED", expected: r.status })} title={t.skip}><SkipForward /></Button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {tab === "staff" && (
        <Section title={`${t.tabs.staff} (${onSite}/${data.shifts.length})`} actions={addBtn("shift", t.newShift)}>
          {data.shifts.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
            <ul className="divide-y">
              {data.shifts.map((s) => (
                <li key={s.id} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_1fr_160px_auto] md:items-center">
                  <button className="text-start" onClick={() => can && setDialog({ kind: "shift", values: s as unknown as Record<string, unknown> })}><div className="text-[13px] font-medium">{s.role}</div><div className="text-[11px] text-muted-foreground">{s.location ?? "—"}</div></button>
                  <span className="text-xs">{nameOf(s.userId)}</span>
                  <span className="ltr-nums text-xs text-muted-foreground">{formatTime(s.startsAt, fmt)} – {formatTime(s.endsAt, fmt)}</span>
                  <div className="flex items-center gap-1">
                    <StatusBadge status={s.status === "CHECKED_IN" ? "ACTIVE" : s.status === "NO_SHOW" ? "FAILED" : s.status} label={t.shiftStatus[s.status as keyof typeof t.shiftStatus]} />
                    {can && s.status === "SCHEDULED" && <><Button size="xs" onClick={() => shift.run({ id: s.id, status: "CHECKED_IN" })}>{t.checkIn}</Button><Button size="xs" variant="ghost" className="text-danger" onClick={() => shift.run({ id: s.id, status: "NO_SHOW" })}>{t.noShow}</Button></>}
                    {can && s.status === "CHECKED_IN" && <Button size="xs" variant="outline" onClick={() => shift.run({ id: s.id, status: "COMPLETED" })}>{t.complete}</Button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {tab === "readiness" && (
        <Section title={`${t.readiness} · ${formatPercent(data.readinessScore, fmt)}`} actions={addBtn("readiness", t.addItem)}>
          <ul className="divide-y">
            {data.readiness.map((r) => (
              <li key={r.id} className="grid gap-2 px-4 py-2.5 md:grid-cols-[120px_1fr_140px_150px] md:items-center" data-testid="readiness-item">
                <span className="text-[11px] text-muted-foreground">{t.readinessCategory[r.category as keyof typeof t.readinessCategory] ?? r.category}</span>
                <button className="text-start" onClick={() => can && setDialog({ kind: "readiness", values: r as unknown as Record<string, unknown> })}><div className="text-[13px]">{r.label}</div>{r.note && <div className={cn("text-[11px]", r.status === "ISSUE" ? "text-danger" : "text-muted-foreground")}>{r.note}</div>}</button>
                <span className="text-xs text-muted-foreground">{nameOf(r.ownerId)}</span>
                {can ? (
                  <NativeSelect
                    value={r.status}
                    aria-label={m.common.status}
                    onChange={(ev) => {
                      const status = ev.target.value as "PENDING" | "IN_PROGRESS" | "READY" | "ISSUE";
                      const note = status === "ISSUE" && !r.note ? window.prompt(t.issueNotePrompt) : undefined;
                      if (status === "ISSUE" && !r.note && !note) return;
                      ready.run({ id: r.id, status, note });
                    }}
                    className={cn("h-8 text-xs", r.status === "READY" && "text-success", r.status === "ISSUE" && "text-danger")}
                  >
                    {Object.entries(t.readinessStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </NativeSelect>
                ) : <StatusBadge status={r.status === "ISSUE" ? "BLOCKED" : r.status} label={t.readinessStatus[r.status as keyof typeof t.readinessStatus]} />}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {tab === "incidents" && (
        <Section title={`${t.tabs.incidents} (${openIncidents.length}/${data.incidents.length})`} actions={addBtn("incident", t.reportIncident)}>
          {data.incidents.length === 0 ? <EmptyState title={t.noIncidents} /> : (
            <ul className="divide-y">
              {data.incidents.map((i) => (
                <li key={i.id} className={cn("grid gap-2 px-4 py-3 md:grid-cols-[100px_1fr_150px_auto] md:items-center", ["RESOLVED", "CLOSED"].includes(i.status) && "opacity-60")} data-testid="incident-row">
                  <StatusBadge status={i.severity === "CRITICAL" || i.severity === "HIGH" ? "FAILED" : i.severity === "MEDIUM" ? "WARNING" : "PENDING"} label={m.enums.severity[i.severity]} />
                  <div>
                    <div className="text-[13px] font-medium">{i.title}{i.escalationLevel > 0 && <span className="ms-1 text-[11px] text-danger">↑{i.escalationLevel}</span>}</div>
                    <div className="text-[11px] text-muted-foreground">{[i.location, i.description].filter(Boolean).join(" · ")}</div>
                    {i.resolution && <div className="text-[11px] text-success">{t.resolution}: {i.resolution}</div>}
                  </div>
                  <div className="grid gap-1">
                    <StatusBadge status={i.status} label={m.enums.incidentStatus[i.status]} />
                    {can && !["RESOLVED", "CLOSED"].includes(i.status) ? (
                      <NativeSelect value={i.ownerId ?? ""} onChange={(ev) => incident.run({ id: i.id, ownerId: ev.target.value || null })} className="h-7 text-[11px]" aria-label={t.owner}>
                        <option value="">{t.unassigned}</option>
                        {people.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </NativeSelect>
                    ) : <span className="text-[11px] text-muted-foreground">{nameOf(i.ownerId)}</span>}
                  </div>
                  {can && (
                    <div className="flex flex-wrap gap-1">
                      {i.status === "OPEN" && <Button size="xs" variant="outline" onClick={() => incident.run({ id: i.id, status: "ACKNOWLEDGED" })}>{t.acknowledge}</Button>}
                      {["OPEN", "ACKNOWLEDGED"].includes(i.status) && <Button size="xs" variant="outline" onClick={() => incident.run({ id: i.id, status: "IN_PROGRESS" })}>{t.startWork}</Button>}
                      {!["RESOLVED", "CLOSED"].includes(i.status) && <Button size="xs" onClick={() => { const resolution = window.prompt(t.resolution); if (resolution?.trim()) incident.run({ id: i.id, status: "RESOLVED", resolution }); }} data-testid="incident-resolve">{t.resolve}</Button>}
                      {!["RESOLVED", "CLOSED"].includes(i.status) && i.severity !== "CRITICAL" && <Button size="xs" variant="ghost" className="text-danger" onClick={() => incident.run({ id: i.id, escalate: true })}><ArrowUpCircle /> {t.escalate}</Button>}
                      {i.status === "RESOLVED" && <><Button size="xs" variant="outline" onClick={() => incident.run({ id: i.id, status: "CLOSED" })}>{t.closeIncident}</Button><Button size="xs" variant="ghost" onClick={() => incident.run({ id: i.id, status: "IN_PROGRESS" })}>{t.reopen}</Button></>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {tab === "logistics" && (
        <Section title={`${t.tabs.logistics} (${data.logistics.length})`} actions={addBtn("logistics", t.newLogistics)}>
          {data.logistics.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
            <ul className="divide-y">
              {data.logistics.map((l) => (
                <li key={l.id} className={cn("grid gap-1 px-4 py-3 md:grid-cols-[1fr_120px_80px_150px_110px] md:items-center", can && "cursor-pointer hover:bg-muted/40")} onClick={() => can && setDialog({ kind: "logistics", values: l as unknown as Record<string, unknown> })}>
                  <div><div className="text-[13px] font-medium">{l.name}</div>{l.notes && <div className="text-[11px] text-muted-foreground">{l.notes}</div>}</div>
                  <span className="text-xs">{t.logisticsCategory[l.category as keyof typeof t.logisticsCategory] ?? l.category}</span>
                  <span className="tabular text-xs">×{l.quantity}</span>
                  <span className="ltr-nums text-xs text-muted-foreground">{l.neededBy ? formatDateTime(l.neededBy, fmt) : "—"}</span>
                  <StatusBadge status={l.status === "INSTALLED" || l.status === "DELIVERED" ? "DONE" : l.status === "ORDERED" ? "IN_PROGRESS" : l.status} label={t.logisticsStatus[l.status as keyof typeof t.logisticsStatus]} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {dialog && (
        <FormDialog
          open
          onOpenChange={(o) => !o && close()}
          title={dialog.values && dialog.kind !== "event" ? String(dialog.values.title ?? dialog.values.name ?? dialog.values.label ?? dialog.values.role ?? dialogTitle[dialog.kind]) : dialogTitle[dialog.kind]}
          fields={fields[dialog.kind]}
          values={dialog.values ?? (dialog.kind === "cue" || dialog.kind === "session" || dialog.kind === "shift" ? { startsAt: e.startsAt, endsAt: e.endsAt } : dialog.kind === "incident" ? { severity: "MEDIUM" } : null)}
          onSubmit={(v) => submit(dialog.kind, v)}
          pending={pendingAny}
          errorFor={errorFor}
          testId={`form-${dialog.kind}`}
        />
      )}
    </div>
  );
}
