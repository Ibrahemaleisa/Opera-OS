"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertCircle, Layers } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/app/data-table";
import { Field, NativeSelect } from "@/components/app/field";
import { Section } from "@/components/app/page";
import { PriorityMark, StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formatRelative, parseRiyadhDate } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { TimeAgo } from "@/components/app/time-ago";
import type { DeliveryRow } from "@/server/modules/delivery/service";
import { bulkAssignAction, createBatchAction } from "@/app/o/[org]/delivery/actions";

export interface Agent { id: string; name: string; capacity: number; open: number; deliveredToday: number; territories: string[] }

export function useAssign(orgSlug: string, projectId: string) {
  const { m, tk } = useI18n();
  const [over, setOver] = useState<{ ids: string[]; agentId: string; message: string } | null>(null);
  const action = useAction(bulkAssignAction, { orgSlug, success: false, onSuccess: (r) => toast.success(interpolate(m.delivery.assigned, { changed: r.changed, skipped: r.skipped.length })) });
  const assign = async (ids: string[], agentId: string | null, override = false) => {
    const r = await action.run({ projectId, deliveryIds: ids, agentId, overrideCapacity: override });
    if (!r.ok && r.code === "OVER_CAPACITY" && agentId) {
      const fe = r.fieldErrors ?? {};
      setOver({ ids, agentId, message: interpolate(m.delivery.overCapacity, { capacity: fe.capacity?.[0], open: fe.open?.[0], incoming: fe.incoming?.[0] }) });
    }
    return r;
  };
  const dialog = over && (
    <Dialog open onOpenChange={(o) => !o && setOver(null)}>
      <DialogContent>
        <DialogHeader><DialogTitle>{tk("delivery.overrideCapacity")}</DialogTitle></DialogHeader>
        <p className="text-sm">{over.message}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOver(null)}>{m.common.cancel}</Button>
          <Button onClick={async () => { await assign(over.ids, over.agentId, true); setOver(null); }}>{m.delivery.overrideCapacity}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { assign, pending: action.pending, dialog };
}

export function DeliveryTable({ orgSlug, projectId, campaignId, campaigns, deliveries, agents, canDispatch, statusFilter }: { orgSlug: string; projectId: string; campaignId: string; campaigns: { id: string; name: string }[]; deliveries: DeliveryRow[]; agents: Agent[]; canDispatch: boolean; statusFilter: string }) {
  const { m, fmt } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const { assign, dialog } = useAssign(orgSlug, projectId);
  const [batchFor, setBatchFor] = useState<string[] | null>(null);
  const batch = useAction(createBatchAction, { orgSlug, onSuccess: () => setBatchFor(null) });
  const set = (k: string, v: string) => { const q = new URLSearchParams(sp.toString()); if (v) q.set(k, v); else q.delete(k); router.replace(`${pathname}?${q}`); };
  const href = (id: string) => `/o/${orgSlug}/projects/${projectId}/delivery/cards/${id}`;
  const columns = useMemo<ColumnDef<DeliveryRow, unknown>[]>(() => [
    { accessorKey: "trackingCode", header: m.delivery.trackingCode, cell: ({ row }) => <Link href={href(row.original.id)} onClick={(e) => e.stopPropagation()} className="ltr-nums font-mono text-xs text-primary hover:underline">{row.original.trackingCode}</Link> },
    { id: "name", accessorFn: (r) => `${r.recipient.nameAr ?? ""} ${r.recipient.nameEn ?? ""} ${r.recipient.code}`, header: m.delivery.recipient, cell: ({ row }) => <div className="min-w-44"><div className="font-medium">{row.original.recipient.honorific ? `${row.original.recipient.honorific} ` : ""}{row.original.recipient.nameAr ?? row.original.recipient.nameEn}</div><div className="text-[11px] text-muted-foreground">{row.original.recipient.organizationName}</div></div> },
    { id: "tier", accessorFn: (r) => r.recipient.vipTier ?? "", header: m.delivery.registry.tier, cell: ({ getValue }) => <span className="text-xs">{getValue() as string}</span> },
    { id: "area", accessorFn: (r) => `${r.recipient.city ?? ""} ${r.recipient.district ?? ""}`, header: m.common.district, cell: ({ row }) => <span className="text-xs">{[row.original.recipient.city, row.original.recipient.district].filter(Boolean).join(" · ")}</span> },
    { id: "mobile", accessorFn: (r) => r.recipient.mobile ?? "", header: m.common.phone, cell: ({ getValue }) => <span className="ltr-nums text-xs">{(getValue() as string) || "—"}</span> },
    { accessorKey: "status", header: m.common.status, cell: ({ row }) => <span className="flex items-center gap-1"><StatusBadge status={row.original.status} label={m.enums.deliveryStatus[row.original.status]} />{row.original.escalatedAt && <AlertCircle className="size-3.5 text-danger" />}</span> },
    { id: "agent", accessorFn: (r) => r.agent?.name ?? "", header: m.delivery.agent, cell: ({ getValue }) => <span className="text-xs">{(getValue() as string) || "—"}</span> },
    { id: "batch", accessorFn: (r) => r.batch?.code ?? "", header: m.delivery.batch, cell: ({ getValue }) => <span className="ltr-nums text-xs">{getValue() as string}</span> },
    { accessorKey: "attemptsCount", header: m.delivery.attempts, cell: ({ getValue }) => <span className="tabular text-xs">{getValue() as number}</span> },
    { accessorKey: "priority", header: m.common.priority, cell: ({ row }) => <PriorityMark priority={row.original.priority} label={m.enums.priority[row.original.priority]} /> },
    { accessorKey: "updatedAt", header: m.common.updatedAt, cell: ({ row }) => <span className="text-[11px] text-muted-foreground"><TimeAgo date={row.original.updatedAt} /></span> },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [m, fmt]);
  return (
    <>
      <Section>
        <DataTable
          data={deliveries}
          columns={columns}
          getRowId={(r) => r.id}
          selectable={canDispatch}
          onRowClick={(r) => router.push(href(r.id))}
          initialHidden={["tier", "batch"]}
          toolbar={
            <>
              <NativeSelect className="h-8 w-52" value={campaignId} onChange={(e) => set("c", e.target.value)} aria-label={m.delivery.campaign}>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect>
              <NativeSelect className="h-8 w-40" value={statusFilter} onChange={(e) => set("status", e.target.value)} aria-label={m.common.status}>
                <option value="">{m.common.status}: {m.common.all}</option>
                {Object.entries(m.enums.deliveryStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </NativeSelect>
            </>
          }
          bulkActions={(rows, clear) => (
            <>
              <select className="h-6 rounded border bg-card px-1 text-xs" defaultValue="" data-testid="bulk-assign" onChange={async (e) => { const v = e.target.value; e.target.value = ""; if (!v) return; const r = await assign(rows.map((x) => x.id), v === "__none" ? null : v); if (r.ok) clear(); }}>
                <option value="">{m.delivery.assignTo}…</option>
                <option value="__none">{m.delivery.unassign}</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.open}/{a.capacity})</option>)}
              </select>
              <button className="flex items-center gap-1 text-xs hover:underline" onClick={() => setBatchFor(rows.map((r) => r.id))}><Layers className="size-3" /> {m.delivery.createBatch}</button>
            </>
          )}
        />
      </Section>
      {dialog}
      <Dialog open={!!batchFor} onOpenChange={(o) => !o && setBatchFor(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{m.delivery.createBatch}</DialogTitle></DialogHeader>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); batch.run({ projectId, campaignId, name: String(fd.get("name")), territory: (fd.get("territory") as string) || null, plannedDate: parseRiyadhDate(fd.get("plannedDate") as string), deliveryIds: batchFor ?? [] }); }}>
            <Field label={m.delivery.batchName} required><Input name="name" required /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={m.delivery.territory}><Input name="territory" /></Field>
              <Field label={m.delivery.plannedDate}><Input type="date" name="plannedDate" dir="ltr" /></Field>
            </div>
            <DialogFooter><Button type="submit" disabled={batch.pending}>{m.common.create}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
