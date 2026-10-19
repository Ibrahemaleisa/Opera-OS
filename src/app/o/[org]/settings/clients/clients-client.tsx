"use client";

import { useState } from "react";
import { Building2, Plus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/app/field";
import { EmptyState, Section } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { formObject } from "@/lib/form";
import { useI18n } from "@/lib/i18n/client";
import { saveClientAction, saveContactAction } from "../actions";

interface Contact { id: string; name: string; title: string | null; email: string | null; phone: string | null; isPrimary: boolean }
interface ClientRow { id: string; name: string; nameEn: string | null; sector: string | null; city: string | null; crNumber: string | null; vatNumber: string | null; website: string | null; notes: string | null; projects: number; contacts: Contact[] }

export function ClientsClient({ orgSlug, clients }: { orgSlug: string; clients: ClientRow[] }) {
  const { m } = useI18n();
  const [edit, setEdit] = useState<ClientRow | "new" | null>(null);
  const [contactFor, setContactFor] = useState<string | null>(null);
  const save = useAction(saveClientAction, { orgSlug, onSuccess: () => setEdit(null) });
  const saveContact = useAction(saveContactAction, { orgSlug, onSuccess: () => setContactFor(null) });
  const current = edit && edit !== "new" ? edit : null;
  return (
    <>
      <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setEdit("new")}><Plus /> {m.org.newClient}</Button></div>
      {clients.length === 0 ? (
        <Section><EmptyState icon={<Building2 />} title={m.common.emptyTitle} action={<Button size="sm" onClick={() => setEdit("new")}>{m.org.newClient}</Button>} /></Section>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {clients.map((c) => (
            <Section key={c.id} title={c.name} description={[c.sector, c.city].filter(Boolean).join(" · ")} actions={<Button variant="ghost" size="sm" onClick={() => setEdit(c)}>{m.common.edit}</Button>}>
              <div className="px-4 py-3 text-xs text-muted-foreground">{m.org.projectsCount}: <span className="tabular text-foreground">{c.projects}</span></div>
              <div className="border-t px-4 py-2">
                <div className="mb-1 flex items-center justify-between text-xs font-medium">{m.org.contacts}
                  <Button variant="ghost" size="xs" onClick={() => setContactFor(c.id)}><UserPlus /> {m.org.addContact}</Button>
                </div>
                <ul className="grid gap-1.5 pb-1">
                  {c.contacts.map((x) => (
                    <li key={x.id} className="text-[13px]">
                      <span className="font-medium">{x.name}</span>{x.isPrimary && <span className="ms-1 text-[10px] text-primary">· {m.org.primary}</span>}
                      <div className="ltr-nums text-xs text-muted-foreground">{[x.title, x.email, x.phone].filter(Boolean).join(" · ")}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </Section>
          ))}
        </div>
      )}
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{current ? current.name : m.org.newClient}</DialogTitle></DialogHeader>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); save.run({ ...formObject(e.currentTarget), id: current?.id } as never); }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label={m.common.nameAr} error={save.errorFor("name")} required><Input name="name" defaultValue={current?.name} required /></Field>
              <Field label={m.common.nameEn}><Input name="nameEn" defaultValue={current?.nameEn ?? ""} dir="ltr" /></Field>
              <Field label={m.org.sector}><Input name="sector" defaultValue={current?.sector ?? ""} /></Field>
              <Field label={m.common.city}><Input name="city" defaultValue={current?.city ?? ""} /></Field>
              <Field label={m.org.crNumber}><Input name="crNumber" defaultValue={current?.crNumber ?? ""} dir="ltr" /></Field>
              <Field label={m.org.vatNumber}><Input name="vatNumber" defaultValue={current?.vatNumber ?? ""} dir="ltr" /></Field>
            </div>
            <Field label={m.org.website}><Input name="website" defaultValue={current?.website ?? ""} dir="ltr" /></Field>
            <Field label={m.common.notes}><Textarea name="notes" defaultValue={current?.notes ?? ""} rows={2} /></Field>
            <DialogFooter><Button type="submit" disabled={save.pending}>{m.common.save}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!contactFor} onOpenChange={(o) => !o && setContactFor(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{m.org.addContact}</DialogTitle></DialogHeader>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); saveContact.run({ ...formObject(e.currentTarget), clientId: contactFor } as never); }}>
            <Field label={m.common.name} required><Input name="name" required /></Field>
            <Field label={m.org.jobTitle}><Input name="title" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={m.common.email} error={saveContact.errorFor("email")}><Input name="email" type="email" dir="ltr" /></Field>
              <Field label={m.common.phone}><Input name="phone" dir="ltr" /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isPrimary" /> {m.org.primary}</label>
            <DialogFooter><Button type="submit" disabled={saveContact.pending}>{m.common.save}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
