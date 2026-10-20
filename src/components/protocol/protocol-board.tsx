"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { Armchair, Eye, Lock, Plus, UserCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/app/data-table";
import { NativeSelect } from "@/components/app/field";
import { FormDialog, enumOptions, type FieldDef } from "@/components/app/form-dialog";
import { ProgressBar, Section, Stat } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formatTime } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import type { listGuests } from "@/server/modules/protocol/service";
import { assignSeatAction, importGuestsAction, revealRestrictedAction, saveAssignmentAction, saveGuestAction, saveZoneAction, setAttendanceAction } from "@/app/o/[org]/protocol/actions";

type D = Awaited<ReturnType<typeof listGuests>>;
type G = D["guests"][number];
type Dlg = { kind: "guest" | "zone" | "seat" | "assignment"; guest?: G | null } | null;

const NEXT: Record<string, { to: string; key: "markArrived" | "markSeated" | "markDeparted" | "confirm" }[]> = {
  EXPECTED: [{ to: "CONFIRMED", key: "confirm" }, { to: "ARRIVED", key: "markArrived" }],
  CONFIRMED: [{ to: "ARRIVED", key: "markArrived" }],
  ARRIVED: [{ to: "SEATED", key: "markSeated" }],
  SEATED: [{ to: "DEPARTED", key: "markDeparted" }],
  NO_SHOW: [{ to: "ARRIVED", key: "markArrived" }],
};

export function ProtocolBoard({ orgSlug, projectId, data }: { orgSlug: string; projectId: string; data: D }) {
  const { m, fmt } = useI18n();
  const t = m.protocol;
  const [q, setQ] = useState("");
  const [att, setAtt] = useState("");
  const [cat, setCat] = useState("");
  const [dlg, setDlg] = useState<Dlg>(null);
  const [revealed, setRevealed] = useState<Record<string, { restrictedNotes: string | null; mobile: string | null }>>({});
  const close = () => setDlg(null);
  const saveGuest = useAction(saveGuestAction, { orgSlug, onSuccess: close });
  const imp = useAction(importGuestsAction, { orgSlug, success: false, onSuccess: (r) => toast.success(interpolate(t.imported, { n: r.created })) });
  const reveal = useAction(revealRestrictedAction, { orgSlug, success: t.revealed, refresh: false });
  const attend = useAction(setAttendanceAction, { orgSlug, success: false });
  const saveZone = useAction(saveZoneAction, { orgSlug, onSuccess: close });
  const seat = useAction(assignSeatAction, { orgSlug, onSuccess: close });
  const saveAsg = useAction(saveAssignmentAction, { orgSlug, onSuccess: close });
  const can = data.scope.manage;
  const eventId = data.events[0]?.id ?? null;

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return data.guests.filter((g) => (!att || g.attendance === att) && (!cat || g.category === cat) && (!s || [g.nameAr, g.nameEn, g.organizationName, g.seatLabel].some((x) => x?.toLowerCase().includes(s))));
  }, [data.guests, q, att, cat]);
  const zoneName = (id: string | null) => data.zones.find((z) => z.id === id)?.name;
  const person = (id: string | null) => data.people.find((p) => p.id === id)?.name;
  const arrived = (data.counts.ARRIVED ?? 0) + (data.counts.SEATED ?? 0);
  const expected = arrived + (data.counts.EXPECTED ?? 0) + (data.counts.CONFIRMED ?? 0);

  const columns = useMemo<ColumnDef<G, unknown>[]>(() => [
    { accessorKey: "protocolLevel", header: t.level, cell: ({ getValue }) => <span className="tabular inline-flex size-6 items-center justify-center rounded-full bg-muted text-xs font-medium">{getValue() as number}</span> },
    {
      accessorKey: "displayName",
      header: m.common.name,
      cell: ({ row: { original: g } }) => (
        <div>
          <div className="flex items-center gap-1 font-medium">{g.honorific} {g.displayName}{g.hasRestricted && <Lock className="size-3 text-warning" aria-label={t.hasRestricted} />}</div>
          <div className="text-[11px] text-muted-foreground">{[g.title, g.organizationName].filter(Boolean).join(" · ")}</div>
          {revealed[g.id]?.restrictedNotes && <div className="mt-1 rounded bg-warning-soft px-2 py-1 text-[11px] text-warning" data-testid="restricted-notes">{revealed[g.id].restrictedNotes}</div>}
        </div>
      ),
    },
    { accessorKey: "category", header: t.category, cell: ({ getValue }) => <span className="text-xs">{t.guestCategory[getValue() as keyof typeof t.guestCategory] ?? (getValue() as string)}</span> },
    { id: "seat", header: t.seat, cell: ({ row: { original: g } }) => <button className="text-xs hover:underline disabled:no-underline" disabled={!can} onClick={(e) => { e.stopPropagation(); setDlg({ kind: "seat", guest: g }); }}>{g.seatZoneId ? `${zoneName(g.seatZoneId)}${g.seatLabel ? ` · ${g.seatLabel}` : ""}` : <span className="text-muted-foreground">{can ? t.assignSeat : "—"}</span>}</button> },
    { id: "escort", header: t.escort, cell: ({ row: { original: g } }) => { const a = g.assignments[0]; return <button className="text-start text-xs hover:underline disabled:no-underline" disabled={!can} onClick={(e) => { e.stopPropagation(); setDlg({ kind: "assignment", guest: g }); }}>{a ? <><div>{person(a.escortId) ?? "—"}{a.checkpoint ? ` · ${a.checkpoint}` : ""}</div><div className="text-[10px] text-muted-foreground">{t.assignmentStatus[a.status as keyof typeof t.assignmentStatus]}</div></> : <span className="text-muted-foreground">{can ? "+" : "—"}</span>}</button>; } },
    { accessorKey: "arrivalAt", header: t.arrivalAt, cell: ({ row: { original: g } }) => <span className="ltr-nums text-xs text-muted-foreground">{g.arrivalAt ? formatTime(g.arrivalAt, fmt) : "—"}{g.arrivalPoint ? ` · ${g.arrivalPoint}` : ""}</span> },
    {
      accessorKey: "attendance",
      header: m.common.status,
      cell: ({ row: { original: g } }) => (
        <div className="flex flex-wrap items-center gap-1" data-testid={`guest-${g.id}`} data-attendance={g.attendance}>
          <StatusBadge status={g.attendance === "ARRIVED" || g.attendance === "SEATED" ? "DELIVERED" : g.attendance === "NO_SHOW" ? "FAILED" : g.attendance} label={m.enums.attendance[g.attendance]} />
          {can && NEXT[g.attendance]?.map((n) => <Button key={n.to} size="xs" variant={n.to === "ARRIVED" ? "default" : "outline"} disabled={attend.pending} onClick={(e) => { e.stopPropagation(); attend.run({ guestId: g.id, attendance: n.to as never, expected: g.attendance }); }}>{t[n.key]}</Button>)}
          {data.scope.restricted && g.hasRestricted && !revealed[g.id] && <Button size="xs" variant="ghost" title={t.reveal} onClick={(e) => { e.stopPropagation(); reveal.run({ guestId: g.id }).then((r) => r.ok && setRevealed((x) => ({ ...x, [g.id]: r.data }))); }} data-testid="reveal-restricted"><Eye /></Button>}
        </div>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [m, t, data, revealed, can]);

  const guestFields: FieldDef[] = [
    { name: "nameAr", label: m.common.nameAr, required: true },
    { name: "nameEn", label: m.common.nameEn, ltr: true },
    { name: "honorific", label: t.honorific },
    { name: "title", label: m.common.title },
    { name: "organizationName", label: m.projects.client, wide: true },
    { name: "category", label: t.category, type: "select", options: enumOptions(t.guestCategory) },
    { name: "protocolLevel", label: t.level, type: "number", min: 1, max: 5, hint: t.levelHint },
    ...(data.scope.vip ? [{ name: "mobile", label: m.common.phone, type: "tel" as const }] : []),
    { name: "eventId", label: m.nav.events, type: "select", empty: "—", options: data.events.map((e) => ({ value: e.id, label: e.name })) },
    { name: "arrivalAt", label: t.arrivalAt, type: "datetime" },
    { name: "arrivalPoint", label: t.arrivalPoint },
    { name: "specialInstructions", label: t.specialInstructions, type: "textarea" },
    ...(data.scope.restricted ? [{ name: "restrictedNotes", label: t.restricted, type: "textarea" as const, hint: t.restrictedHint }] : []),
  ];
  const g = dlg?.guest ?? null;
  const asg = g?.assignments[0];

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label={t.guests} value={data.guests.length} icon={<Users />} />
        <Stat label={t.expectedCount} value={expected} />
        <Stat label={t.arrivedCount} value={arrived} tone="success" icon={<UserCheck />} />
        <Stat label={m.enums.attendance.SEATED} value={data.counts.SEATED ?? 0} />
        <Stat label={m.enums.attendance.NO_SHOW} value={data.counts.NO_SHOW ?? 0} tone={data.counts.NO_SHOW ? "danger" : "default"} />
      </div>
      {can && data.unlinkedRecipients > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-info-soft px-3 py-2 text-xs text-info">
          {interpolate(t.unlinked, { n: data.unlinkedRecipients })}
          <Button size="xs" variant="outline" className="ms-auto" disabled={imp.pending} onClick={() => imp.run({ projectId, eventId })} data-testid="import-guests">{t.importFromRegistry}</Button>
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Section
          title={`${t.guests} (${rows.length})`}
          actions={can && <Button size="sm" onClick={() => setDlg({ kind: "guest" })}><Plus /> {t.newGuest}</Button>}
        >
          <div className="flex flex-wrap gap-2 border-b px-4 py-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={m.common.search} className="h-8 w-56" />
            <NativeSelect value={att} onChange={(e) => setAtt(e.target.value)} className="h-8 w-40 text-xs"><option value="">{m.common.status}</option>{Object.entries(m.enums.attendance).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect>
            <NativeSelect value={cat} onChange={(e) => setCat(e.target.value)} className="h-8 w-40 text-xs"><option value="">{t.category}</option>{Object.entries(t.guestCategory).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect>
          </div>
          <DataTable data={rows} columns={columns} getRowId={(r) => r.id} pageSize={50} onRowClick={can ? (r) => setDlg({ kind: "guest", guest: r }) : undefined} />
        </Section>
        <Section title={t.zones} actions={can && data.events.length > 0 && <Button size="xs" variant="outline" onClick={() => setDlg({ kind: "zone" })}><Plus /> {t.newZone}</Button>}>
          <ul className="grid gap-3 p-4">
            {data.zones.length === 0 && <li className="text-xs text-muted-foreground">{m.common.none}</li>}
            {data.zones.map((z) => (
              <li key={z.id} className="grid gap-1 text-xs">
                <div className="flex items-center justify-between"><span className="flex items-center gap-1 font-medium"><Armchair className="size-3.5" /> {z.name}</span><span className="tabular text-muted-foreground">{z.occupied}/{z.capacity || "∞"}{z.protocolLevel ? ` · ≤${z.protocolLevel}` : ""}</span></div>
                {z.capacity > 0 && <ProgressBar value={(z.occupied / z.capacity) * 100} tone={z.occupied >= z.capacity ? "warning" : "brand"} />}
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {dlg?.kind === "guest" && (
        <FormDialog open onOpenChange={(o) => !o && close()} title={g?.displayName ?? t.newGuest} fields={guestFields} values={g ? { ...g, mobile: revealed[g.id]?.mobile ?? (data.scope.vip ? g.mobile : null), restrictedNotes: revealed[g.id]?.restrictedNotes ?? null } : { category: "VIP", protocolLevel: 3, eventId }} extra={{ id: g?.id, projectId }} onSubmit={(v) => saveGuest.run({ ...v, protocolLevel: v.protocolLevel ?? 3, ...(data.scope.restricted && g?.hasRestricted && !revealed[g.id] ? { restrictedNotes: undefined } : {}) } as never)} pending={saveGuest.pending} errorFor={saveGuest.errorFor} testId="form-guest">
          {data.scope.restricted && g?.hasRestricted && !revealed[g.id] && <p className="text-[11px] text-warning"><Lock className="me-1 inline size-3" />{t.restrictedHint}</p>}
        </FormDialog>
      )}
      {dlg?.kind === "zone" && (
        <FormDialog open onOpenChange={(o) => !o && close()} title={t.newZone} fields={[{ name: "name", label: m.common.name, required: true }, { name: "capacity", label: t.capacity, type: "number", min: 0, required: true }, { name: "protocolLevel", label: t.minLevel, type: "number", min: 1, max: 5, hint: t.levelHint }, { name: "eventId", label: m.nav.events, type: "select", options: data.events.map((e) => ({ value: e.id, label: e.name })) }]} values={{ eventId, capacity: 20 }} onSubmit={(v) => saveZone.run(v as never)} pending={saveZone.pending} errorFor={saveZone.errorFor} />
      )}
      {dlg?.kind === "seat" && g && (
        <FormDialog open onOpenChange={(o) => !o && close()} title={`${t.assignSeat} — ${g.displayName}`} fields={[{ name: "seatZoneId", label: t.zone, type: "select", empty: t.noZone, options: data.zones.map((z) => ({ value: z.id, label: `${z.name} (${z.occupied}/${z.capacity || "∞"})` })) }, { name: "seatLabel", label: t.seat, ltr: true }]} values={g} extra={{ guestId: g.id }} onSubmit={(v) => seat.run(v as never)} pending={seat.pending} errorFor={seat.errorFor} />
      )}
      {dlg?.kind === "assignment" && g && (
        <FormDialog
          open
          onOpenChange={(o) => !o && close()}
          title={`${t.assignment} — ${g.displayName}`}
          fields={[
            { name: "escortId", label: t.escort, type: "select", empty: "—", options: data.people.map((p) => ({ value: p.id, label: p.name })) },
            { name: "checkpoint", label: t.checkpoint },
            { name: "transport", label: t.transport },
            { name: "vehicle", label: t.vehicle },
            { name: "driverName", label: t.driver },
            { name: "pickupAt", label: t.pickupAt, type: "datetime" },
            { name: "status", label: m.common.status, type: "select", options: enumOptions(t.assignmentStatus) },
            { name: "notes", label: m.common.notes, type: "textarea" },
          ]}
          values={asg ?? { status: "PLANNED" }}
          extra={{ id: asg?.id, guestId: g.id }}
          onSubmit={(v) => saveAsg.run(v as never)}
          pending={saveAsg.pending}
          errorFor={saveAsg.errorFor}
        />
      )}
    </div>
  );
}
