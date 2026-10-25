"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/app/data-table";
import { Field, NativeSelect } from "@/components/app/field";
import { Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formatDate } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import type { listRecipients, MaskedRecipient } from "@/server/modules/delivery/service";
import { anonymizeAction, generateDeliveriesAction, revealRecipientAction, updateRecipientAction } from "@/app/o/[org]/delivery/actions";
import { ActionButton } from "@/components/app/action-button";

type Row = Awaited<ReturnType<typeof listRecipients>>["rows"][number];

export function RecipientRegistry({ orgSlug, rows, vip, campaigns, projectId, canManage, showProject }: { orgSlug: string; rows: Row[]; vip: boolean; campaigns: { id: string; name: string }[]; projectId?: string; canManage: boolean; showProject?: boolean }) {
  const { m, fmt, tk } = useI18n();
  const r = m.delivery.registry;
  const [edit, setEdit] = useState<Row | null>(null);
  const [revealed, setRevealed] = useState<Record<string, MaskedRecipient>>({});
  const [anon, setAnon] = useState<string[] | "expired" | null>(null);
  const gen = useAction(generateDeliveriesAction, { orgSlug, success: false, onSuccess: (d) => toast.success(interpolate(m.delivery.generated, d)) });
  const reveal = useAction(revealRecipientAction, { orgSlug, success: false, refresh: false, onSuccess: (d) => setRevealed((x) => ({ ...x, [d.id]: d })) });
  const anonymize = useAction(anonymizeAction, { orgSlug, success: false, onSuccess: (d) => { toast.success(interpolate(r.anonymized, { n: d.anonymized })); setAnon(null); } });
  const save = useAction(updateRecipientAction, { orgSlug, onSuccess: () => setEdit(null) });
  const columns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    { accessorKey: "code", header: r.code, size: 90, cell: ({ getValue }) => <span className="ltr-nums font-mono text-xs text-muted-foreground">{getValue() as string}</span> },
    { id: "name", accessorFn: (x) => `${x.nameAr ?? ""} ${x.nameEn ?? ""}`, header: m.common.name, cell: ({ row }) => row.original.anonymized ? <span className="text-xs text-muted-foreground italic">{m.common.sensitiveHidden}</span> : <div><div className="font-medium">{row.original.honorific ? `${row.original.honorific} ` : ""}{row.original.nameAr ?? row.original.nameEn}</div>{row.original.nameEn && row.original.nameAr && <div className="text-[11px] text-muted-foreground" dir="ltr">{row.original.nameEn}</div>}</div> },
    { id: "org", accessorFn: (x) => `${x.jobTitle ?? ""} ${x.organizationName ?? ""}`, header: m.projects.client, cell: ({ row }) => <div className="text-xs"><div>{row.original.organizationName}</div><div className="text-muted-foreground">{row.original.jobTitle}</div></div> },
    { accessorKey: "vipTier", header: r.tier, cell: ({ getValue }) => <span className="text-xs">{(getValue() as string) ?? ""}</span> },
    {
      id: "mobile",
      accessorFn: (x) => x.mobile ?? "",
      header: m.common.phone,
      cell: ({ row }) => {
        const rv = revealed[row.original.id];
        return <span className="ltr-nums text-xs">{rv?.mobile ?? row.original.mobile ?? "—"}{row.original.masked && vip && !rv && row.original.mobile && <ActionButton variant="ghost" size="icon-xs" className="ms-1 text-primary" title={m.delivery.revealAudited} aria-label={m.delivery.revealAudited} onClick={(e) => e.stopPropagation()} action={() => reveal.run({ recipientId: row.original.id })}><Eye className="size-3" /></ActionButton>}</span>;
      },
    },
    { id: "area", accessorFn: (x) => `${x.city ?? ""} ${x.district ?? ""}`, header: m.common.city, cell: ({ row }) => <span className="text-xs">{[row.original.city, row.original.district].filter(Boolean).join(" · ")}</span> },
    { accessorKey: "verificationStatus", header: r.verification, cell: ({ getValue }) => <StatusBadge status={getValue() as string} label={getValue() as string} /> },
    { id: "deliveries", accessorFn: (x) => x.deliveries.length, header: r.deliveries, cell: ({ row }) => <span className="flex flex-wrap gap-1">{row.original.deliveries.map((d) => <Link key={d.id} href={`/o/${orgSlug}/projects/${row.original.projectId}/delivery/cards/${d.id}`} onClick={(e) => e.stopPropagation()}><StatusBadge status={d.status} label={m.enums.deliveryStatus[d.status]} /></Link>)}</span> },
    ...(showProject ? [{ id: "project", accessorFn: (x: Row) => x.project.code, header: m.nav.projects, cell: ({ row }: { row: { original: Row } }) => <Link href={`/o/${orgSlug}/projects/${row.original.projectId}/delivery/recipients`} className="ltr-nums text-xs text-primary" onClick={(e) => e.stopPropagation()}>{row.original.project.code}</Link> } as ColumnDef<Row, unknown>] : []),
    { id: "retention", accessorFn: (x) => x.retentionUntil ?? "", header: r.retention, cell: ({ row }) => <span className="tabular text-[11px] text-muted-foreground">{formatDate(row.original.retentionUntil, fmt)}</span> },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [m, fmt, revealed, vip, showProject]);
  return (
    <>
      <Section>
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(x) => x.id}
          selectable={canManage && !!projectId}
          onRowClick={canManage && projectId ? (x) => !x.anonymized && setEdit(x) : undefined}
          initialHidden={["retention", "verificationStatus"]}
          toolbar={canManage && projectId && <Button size="sm" variant="ghost" onClick={() => setAnon("expired")}><ShieldOff /> {r.anonymizeExpired}</Button>}
          bulkActions={(sel, clear) => (
            <>
              <select className="h-6 rounded border bg-card px-1 text-xs" defaultValue="" onChange={(e) => { const c = e.target.value; e.target.value = ""; if (c) gen.run({ campaignId: c, recipientIds: sel.map((x) => x.id) }).then(clear); }} aria-label={m.delivery.generateCards}>
                <option value="">{m.delivery.generateCards}…</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="flex items-center gap-1 text-xs text-danger hover:underline" onClick={() => setAnon(sel.map((x) => x.id))}><ShieldOff className="size-3" /> {r.anonymize}</button>
            </>
          )}
        />
      </Section>
      <Dialog open={!!anon} onOpenChange={(o) => !o && setAnon(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{anon === "expired" ? r.anonymizeExpired : r.anonymize}</DialogTitle><DialogDescription>{m.auth.privacyNote}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="destructive" disabled={anonymize.pending} onClick={() => projectId && anonymize.run(anon === "expired" ? { projectId, expiredOnly: true } : { projectId, recipientIds: anon as string[] })}>{m.common.confirm}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{r.edit} · <span className="ltr-nums font-mono">{edit?.code}</span></DialogTitle></DialogHeader>
          {edit && (
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const patch: Record<string, unknown> = { id: edit.id };
              for (const k of ["nameAr", "nameEn", "honorific", "jobTitle", "organizationName", "vipTier", "city", "district", "preferredWindow", "notes", ...(vip ? ["mobile", "address", "mapsUrl", "deliveryInstructions"] : [])]) {
                const v = fd.get(k);
                if (v !== null && String(v) !== String((edit as Record<string, unknown>)[k] ?? "")) patch[k] = String(v) || null;
              }
              patch.priority = fd.get("priority");
              patch.verificationStatus = fd.get("verificationStatus");
              save.run(patch as never);
            }}>
              {([["nameAr", m.common.nameAr], ["nameEn", m.common.nameEn], ["honorific", m.common.title], ["jobTitle", m.org.jobTitle], ["organizationName", m.projects.client], ["vipTier", r.tier], ["city", m.common.city], ["district", m.common.district], ["preferredWindow", m.delivery.field.window]] as const).map(([k, l]) => (
                <Field key={k} label={l}><Input name={k} defaultValue={(edit as Record<string, unknown>)[k] as string ?? ""} /></Field>
              ))}
              {vip && (["mobile", "address", "mapsUrl", "deliveryInstructions"] as const).map((k) => (
                <Field key={k} label={k === "mobile" ? m.common.phone : k === "address" ? m.common.address : k === "mapsUrl" ? m.org.mapsUrl : m.delivery.field.instructions} error={save.errorFor(k)}><Input name={k} defaultValue={(revealed[edit.id] ?? edit)[k] ?? ""} dir={k === "mobile" || k === "mapsUrl" ? "ltr" : undefined} /></Field>
              ))}
              <Field label={m.common.priority}><NativeSelect name="priority" defaultValue={edit.priority}>{Object.entries(m.enums.priority).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Field>
              <Field label={r.verification}><NativeSelect name="verificationStatus" defaultValue={edit.verificationStatus}>{["UNVERIFIED", "VERIFIED", "INVALID"].map((v) => <option key={v}>{v}</option>)}</NativeSelect></Field>
              <DialogFooter className="sm:col-span-2"><Button type="submit" disabled={save.pending}>{m.common.save}</Button></DialogFooter>
            </form>
          )}
          {save.fieldErrors._ && <p className="text-xs text-danger">{tk(save.fieldErrors._[0])}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
