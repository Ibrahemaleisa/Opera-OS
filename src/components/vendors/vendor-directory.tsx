"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/app/data-table";
import { NativeSelect } from "@/components/app/field";
import { FormDialog, enumOptions } from "@/components/app/form-dialog";
import { Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formatMoney, formatPercent } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import type { listVendors } from "@/server/modules/vendors/service";
import { saveVendorAction } from "@/app/o/[org]/vendors/actions";

type D = Awaited<ReturnType<typeof listVendors>>;
type V = D["vendors"][number];

export function VendorDirectory({ orgSlug, data }: { orgSlug: string; data: D }) {
  const { m, fmt } = useI18n();
  const t = m.vendors;
  const [edit, setEdit] = useState<V | "new" | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const save = useAction(saveVendorAction, { orgSlug, onSuccess: () => setEdit(null) });
  const rows = useMemo(() => data.vendors.filter((v) => (!cat || v.category === cat) && (!q || [v.name, v.nameEn, v.city].some((x) => x?.toLowerCase().includes(q.toLowerCase())))), [data.vendors, q, cat]);
  const columns = useMemo<ColumnDef<V, unknown>[]>(() => [
    { accessorKey: "name", header: m.common.name, cell: ({ row: { original: v } }) => <div><div className="font-medium">{v.name}</div><div className="text-[11px] text-muted-foreground">{[v.city, v.crNumber && `${t.cr} ${v.crNumber}`].filter(Boolean).join(" · ")}</div></div> },
    { accessorKey: "category", header: t.category, cell: ({ getValue }) => <span className="text-xs">{m.enums.vendorCategory[getValue() as keyof typeof m.enums.vendorCategory] ?? (getValue() as string)}</span> },
    { accessorKey: "status", header: m.common.status, cell: ({ row: { original: v } }) => <StatusBadge status={v.status === "BLACKLISTED" ? "FAILED" : v.status === "ON_HOLD" ? "ON_HOLD" : v.status === "PREFERRED" ? "DONE" : "ACTIVE"} label={t.status[v.status as keyof typeof t.status]} /> },
    { id: "rating", header: t.rating, cell: ({ row: { original: v } }) => v.perf.avgRating ? <span className="tabular flex items-center gap-1 text-xs"><Star className="size-3 fill-warning text-warning" />{v.perf.avgRating.toFixed(1)} <span className="text-muted-foreground">({v.perf.completed})</span></span> : <span className="text-xs text-muted-foreground">—</span> },
    { id: "onTime", header: t.onTime, cell: ({ row: { original: v } }) => <span className="tabular text-xs">{formatPercent(v.perf.onTimeRate, fmt)}</span> },
    { id: "win", header: t.winRate, cell: ({ row: { original: v } }) => <span className="tabular text-xs">{formatPercent(v.perf.winRate, fmt)} <span className="text-muted-foreground">({v.perf.quotes})</span></span> },
    { id: "active", header: t.activeWork, cell: ({ row: { original: v } }) => <span className="tabular text-xs">{v.perf.active}</span> },
    ...(data.showSpend ? [{ id: "spend", header: t.spend, cell: ({ row: { original: v } }: { row: { original: V } }) => <span className="tabular text-xs">{formatMoney(v.perf.spend, { ...fmt, compact: true })}</span> }] : []),
  ], [m, t, fmt, data.showSpend]);
  const current = edit && edit !== "new" ? edit : null;
  return (
    <>
      <Section title={`${t.title} (${rows.length})`} actions={data.canManage && <Button size="sm" onClick={() => setEdit("new")}><Plus /> {t.newVendor}</Button>}>
        <div className="flex flex-wrap gap-2 border-b px-4 py-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={m.common.search} aria-label={m.common.search} className="h-8 w-56" />
          <NativeSelect value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t.category} className="h-8 w-44 text-xs"><option value="">{t.category}</option>{Object.entries(m.enums.vendorCategory).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect>
        </div>
        <DataTable data={rows} columns={columns} getRowId={(r) => r.id} searchable={false} onRowClick={data.canManage ? (r) => setEdit(r) : undefined} />
      </Section>
      {edit && (
        <FormDialog
          open
          onOpenChange={(o) => !o && setEdit(null)}
          title={current?.name ?? t.newVendor}
          fields={[
            { name: "name", label: m.common.nameAr, required: true },
            { name: "nameEn", label: m.common.nameEn, ltr: true },
            { name: "category", label: t.category, type: "select", options: enumOptions(m.enums.vendorCategory) },
            { name: "status", label: m.common.status, type: "select", options: enumOptions(t.status) },
            { name: "crNumber", label: t.cr, type: "digits", hint: "10" },
            { name: "vatNumber", label: t.vat, type: "digits", hint: "3XXXXXXXXXXXXX3" },
            { name: "email", label: m.common.email, type: "email" },
            { name: "phone", label: m.common.phone, type: "tel" },
            { name: "city", label: t.city },
            { name: "notes", label: m.common.notes, type: "textarea" },
          ]}
          values={current ?? { category: "FABRICATION", status: "ACTIVE" }}
          extra={{ id: current?.id }}
          onSubmit={(v) => save.run(v as never)}
          pending={save.pending}
          errorFor={save.errorFor}
          testId="form-vendor"
        />
      )}
    </>
  );
}
