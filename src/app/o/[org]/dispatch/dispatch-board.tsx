"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Info, Kanban, List, Map as MapIcon, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/app/field";
import { ProgressBar, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { ViewSwitch } from "@/app/o/[org]/projects/portfolio-views";
import { DeliveryTable, useAssign, type Agent } from "@/components/delivery/delivery-table";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { DeliveryRow } from "@/server/modules/delivery/service";

const POOL = ["PENDING", "VALIDATING", "READY", "FAILED_ATTEMPT", "RESCHEDULED", "RETURNED"];

export function DispatchBoard({ orgSlug, projectId, campaignId, campaigns, deliveries, agents, batches, view }: { orgSlug: string; projectId: string; campaignId: string; campaigns: { id: string; name: string; project: string }[]; deliveries: DeliveryRow[]; agents: Agent[]; batches: { id: string; code: string; name: string }[]; view: string }) {
  const { m } = useI18n();
  const dd = m.delivery.dispatch;
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [batch, setBatch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [auto, setAuto] = useState(true);
  const [over, setOver] = useState<string | null>(null);
  const { assign, pending, dialog } = useAssign(orgSlug, projectId);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => document.visibilityState === "visible" && router.refresh(), 20_000);
    return () => clearInterval(id);
  }, [auto, router]);

  const cities = useMemo(() => [...new Set(deliveries.map((d) => d.recipient.city).filter(Boolean))] as string[], [deliveries]);
  const districts = useMemo(() => [...new Set(deliveries.filter((d) => !city || d.recipient.city === city).map((d) => d.recipient.district).filter(Boolean))] as string[], [deliveries, city]);
  const filtered = deliveries.filter((d) => (!city || d.recipient.city === city) && (!district || d.recipient.district === district) && (!batch || d.batch?.id === batch));
  const pool = filtered.filter((d) => POOL.includes(d.status) && (!d.agent || d.status !== "ASSIGNED"));
  const assignablePool = pool.filter((d) => ["READY", "FAILED_ATTEMPT", "RESCHEDULED", "RETURNED"].includes(d.status));
  const byAgent = (id: string) => filtered.filter((d) => d.agent?.id === id && !["DELIVERED", "CANCELLED"].includes(d.status) && !POOL.slice(0, 3).includes(d.status));
  const setCampaign = (id: string) => { const q = new URLSearchParams(sp.toString()); q.set("campaign", id); q.delete("project"); router.replace(`${pathname}?${q}`); };

  const doAssign = async (ids: string[], agentId: string) => {
    const r = await assign(ids, agentId);
    if (r.ok) setSelected(new Set());
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect className="h-8 w-72" value={campaignId} onChange={(e) => setCampaign(e.target.value)} aria-label={dd.selectCampaign}>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.project} · {c.name}</option>)}
        </NativeSelect>
        <ViewSwitch current={view} views={[{ key: "board", label: dd.board, icon: <Kanban /> }, { key: "table", label: dd.table, icon: <List /> }, { key: "map", label: dd.map, icon: <MapIcon /> }]} />
        <NativeSelect className="h-8 w-36" value={city} onChange={(e) => { setCity(e.target.value); setDistrict(""); }} aria-label={dd.filterCity}><option value="">{dd.filterCity}</option>{cities.map((c) => <option key={c}>{c}</option>)}</NativeSelect>
        <NativeSelect className="h-8 w-36" value={district} onChange={(e) => setDistrict(e.target.value)} aria-label={dd.filterDistrict}><option value="">{dd.filterDistrict}</option>{districts.map((c) => <option key={c}>{c}</option>)}</NativeSelect>
        <NativeSelect className="h-8 w-40" value={batch} onChange={(e) => setBatch(e.target.value)} aria-label={m.delivery.batch}><option value="">{m.delivery.batch}</option>{batches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</NativeSelect>
        <label className="ms-auto flex items-center gap-1.5 text-xs text-muted-foreground"><Checkbox checked={auto} onCheckedChange={(v) => setAuto(!!v)} /> {dd.autoRefresh}</label>
        <Button size="icon-sm" variant="ghost" onClick={() => router.refresh()} aria-label={m.common.refresh}><RefreshCw /></Button>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Info className="size-3.5" /> {dd.noRouting}</p>

      {view === "table" ? (
        <DeliveryTable orgSlug={orgSlug} projectId={projectId} campaignId={campaignId} campaigns={[]} deliveries={filtered} agents={agents} canDispatch statusFilter="" />
      ) : view === "map" ? (
        <MapPlot orgSlug={orgSlug} projectId={projectId} deliveries={filtered} />
      ) : (
        <div className="grid auto-cols-[minmax(280px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
          <div className="flex max-h-[72vh] flex-col rounded-lg bg-muted/50 p-2">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <span className="text-sm font-semibold">{dd.pool} <span className="tabular text-xs text-muted-foreground">({pool.length})</span></span>
              <Checkbox checked={selected.size > 0 && selected.size === assignablePool.length} onCheckedChange={(v) => setSelected(v ? new Set(assignablePool.map((d) => d.id)) : new Set())} aria-label="select all" />
            </div>
            {selected.size > 0 && (
              <NativeSelect className="mb-2 h-8" value="" disabled={pending} onChange={(e) => e.target.value && doAssign([...selected], e.target.value)} data-testid="dispatch-assign">
                <option value="">{m.delivery.assignTo} ({selected.size})…</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.open}/{a.capacity}</option>)}
              </NativeSelect>
            )}
            <div className="grid gap-1.5 overflow-y-auto">
              {pool.map((d) => (
                <MiniCard key={d.id} d={d} orgSlug={orgSlug} projectId={projectId} selectable={assignablePool.includes(d)} selected={selected.has(d.id)} dragIds={[...selected]} onSelect={(v) => setSelected((s) => { const n = new Set(s); if (v) n.add(d.id); else n.delete(d.id); return n; })} />
              ))}
            </div>
          </div>
          {agents.map((a) => {
            const items = byAgent(a.id);
            const load = a.open / Math.max(1, a.capacity);
            return (
              <div
                key={a.id}
                onDragOver={(e) => { e.preventDefault(); setOver(a.id); }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => { e.preventDefault(); setOver(null); const ids = (e.dataTransfer.getData("text/deliveries") || "").split(",").filter(Boolean); if (ids.length) doAssign(ids, a.id); }}
                className={cn("flex max-h-[72vh] flex-col rounded-lg bg-muted/50 p-2 transition-colors", over === a.id && "bg-jade-soft ring-1 ring-primary/40")}
                data-testid={`agent-col-${a.id}`}
              >
                <div className="mb-2 px-1">
                  <div className="flex items-center justify-between text-sm font-semibold">{a.name}<span className="tabular text-xs font-normal text-muted-foreground">{a.open}/{a.capacity}</span></div>
                  <ProgressBar value={load * 100} tone={load > 1 ? "danger" : load > 0.8 ? "warning" : "jade"} className="mt-1" />
                  <div className="mt-1 text-[11px] text-muted-foreground">{dd.today}: {a.deliveredToday} ✓{a.territories.length ? ` · ${a.territories.join("، ")}` : ""}</div>
                </div>
                <div className="grid gap-1.5 overflow-y-auto">{items.map((d) => <MiniCard key={d.id} d={d} orgSlug={orgSlug} projectId={projectId} />)}</div>
              </div>
            );
          })}
        </div>
      )}
      {dialog}
    </div>
  );

}

function MiniCard({ d, orgSlug, projectId, selectable, selected, dragIds, onSelect }: { d: DeliveryRow; orgSlug: string; projectId: string; selectable?: boolean; selected?: boolean; dragIds?: string[]; onSelect?: (v: boolean) => void }) {
  const { m } = useI18n();
  return (
    <div
      draggable={selectable}
      onDragStart={(e) => e.dataTransfer.setData("text/deliveries", (selected && dragIds?.length ? dragIds : [d.id]).join(","))}
      className={cn("surface flex items-start gap-2 p-2 text-[12.5px]", selected && "border-primary bg-jade-soft/50", d.escalatedAt && "border-s-2 border-s-danger")}
      data-testid="dispatch-card"
    >
      {selectable && <Checkbox checked={selected} onCheckedChange={(v) => onSelect?.(!!v)} className="mt-0.5" aria-label={d.trackingCode} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-1">
          <Link href={`/o/${orgSlug}/projects/${projectId}/delivery/cards/${d.id}`} className="truncate font-medium hover:text-primary">{d.recipient.nameAr ?? d.recipient.nameEn}</Link>
          <StatusBadge status={d.status} label={m.enums.deliveryStatus[d.status]} dot={false} />
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{[d.recipient.city, d.recipient.district].filter(Boolean).join(" · ")}{d.attemptsCount ? ` · ${m.delivery.attempts}: ${d.attemptsCount}` : ""}</div>
      </div>
    </div>
  );
}

/** Honest location plot: equirectangular projection of provided coordinates only. */
function MapPlot({ orgSlug, projectId, deliveries }: { orgSlug: string; projectId: string; deliveries: DeliveryRow[] }) {
  const { m } = useI18n();
  const pts = deliveries.filter((d) => d.recipient.lat != null && d.recipient.lng != null);
  const missing = deliveries.length - pts.length;
  if (!pts.length) return <Section><p className="p-6 text-center text-sm text-muted-foreground">{m.delivery.dispatch.noCoords}: {missing}</p></Section>;
  const lats = pts.map((p) => p.recipient.lat!);
  const lngs = pts.map((p) => p.recipient.lng!);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const pad = 0.01;
  const x = (lng: number) => ((lng - minLng + pad) / (maxLng - minLng + 2 * pad)) * 1000;
  const y = (lat: number) => (1 - (lat - minLat + pad) / (maxLat - minLat + 2 * pad)) * 560;
  const color: Record<string, string> = { DELIVERED: "var(--success)", FAILED_ATTEMPT: "var(--danger)", ASSIGNED: "var(--violet)", OUT_FOR_DELIVERY: "var(--info)", RESCHEDULED: "var(--warning)" };
  return (
    <Section description={m.delivery.dispatch.mapNote}>
      <div dir="ltr" className="relative">
        <svg viewBox="0 0 1000 560" className="h-auto w-full bg-muted/30" role="img" aria-label={m.delivery.dispatch.map}>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={1000} y1={560 * f} y2={560 * f} stroke="var(--border)" strokeDasharray="4 6" />)}
          {[0.25, 0.5, 0.75].map((f) => <line key={`v${f}`} y1={0} y2={560} x1={1000 * f} x2={1000 * f} stroke="var(--border)" strokeDasharray="4 6" />)}
          {pts.map((d) => (
            <a key={d.id} href={`/o/${orgSlug}/projects/${projectId}/delivery/cards/${d.id}`}>
              <circle cx={x(d.recipient.lng!)} cy={y(d.recipient.lat!)} r={6} fill={color[d.status] ?? "var(--muted-foreground)"} fillOpacity={0.85} stroke="var(--card)" strokeWidth={1.5}>
                <title>{`${d.recipient.nameAr ?? d.recipient.nameEn} · ${m.enums.deliveryStatus[d.status]}`}</title>
              </circle>
            </a>
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
        {Object.entries(color).map(([k, c]) => <span key={k} className="flex items-center gap-1"><span className="size-2.5 rounded-full" style={{ background: c }} />{m.enums.deliveryStatus[k as keyof typeof m.enums.deliveryStatus]}</span>)}
        {missing > 0 && <span className="ms-auto">{m.delivery.dispatch.noCoords}: {missing}</span>}
      </div>
    </Section>
  );
}
