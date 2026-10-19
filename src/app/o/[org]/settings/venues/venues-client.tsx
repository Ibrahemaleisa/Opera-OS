"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/app/data-table";
import { Field } from "@/components/app/field";
import { Section } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { formObject } from "@/lib/form";
import { useI18n } from "@/lib/i18n/client";
import { saveVenueAction } from "../actions";

interface Venue { id: string; name: string; nameEn: string | null; city: string; district: string | null; address: string | null; mapsUrl: string | null; capacity: number | null; notes: string | null; projects: number }

export function VenuesClient({ orgSlug, venues }: { orgSlug: string; venues: Venue[] }) {
  const { m } = useI18n();
  const [edit, setEdit] = useState<Venue | "new" | null>(null);
  const save = useAction(saveVenueAction, { orgSlug, onSuccess: () => setEdit(null) });
  const current = edit && edit !== "new" ? edit : null;
  const columns = useMemo<ColumnDef<Venue, unknown>[]>(() => [
    { accessorKey: "name", header: m.common.name, cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    { accessorKey: "city", header: m.common.city },
    { accessorKey: "district", header: m.common.district },
    { accessorKey: "capacity", header: m.org.capacity, cell: ({ getValue }) => <span className="tabular">{(getValue() as number) ?? "—"}</span> },
    { accessorKey: "projects", header: m.org.projectsCount },
    { id: "map", header: "", cell: ({ row }) => row.original.mapsUrl && <a href={row.original.mapsUrl} target="_blank" rel="noreferrer" className="text-primary" onClick={(e) => e.stopPropagation()}><ExternalLink className="size-3.5" /></a> },
  ], [m]);
  return (
    <>
      <Section actions={<Button size="sm" onClick={() => setEdit("new")}><Plus /> {m.org.newVenue}</Button>} title={`${m.org.venuesTitle} (${venues.length})`}>
        <DataTable data={venues} columns={columns} onRowClick={(r) => setEdit(r)} />
      </Section>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{current?.name ?? m.org.newVenue}</DialogTitle></DialogHeader>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); save.run({ ...formObject(e.currentTarget), id: current?.id } as never); }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label={m.common.nameAr} required><Input name="name" defaultValue={current?.name} required /></Field>
              <Field label={m.common.nameEn}><Input name="nameEn" defaultValue={current?.nameEn ?? ""} dir="ltr" /></Field>
              <Field label={m.common.city} required error={save.errorFor("city")}><Input name="city" defaultValue={current?.city} required /></Field>
              <Field label={m.common.district}><Input name="district" defaultValue={current?.district ?? ""} /></Field>
              <Field label={m.org.capacity}><Input name="capacity" type="number" min={0} defaultValue={current?.capacity ?? ""} dir="ltr" /></Field>
              <Field label={m.org.mapsUrl} error={save.errorFor("mapsUrl")}><Input name="mapsUrl" type="url" defaultValue={current?.mapsUrl ?? ""} dir="ltr" /></Field>
            </div>
            <Field label={m.common.address}><Input name="address" defaultValue={current?.address ?? ""} /></Field>
            <Field label={m.common.notes}><Textarea name="notes" defaultValue={current?.notes ?? ""} rows={2} /></Field>
            <DialogFooter><Button type="submit" disabled={save.pending}>{m.common.save}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
