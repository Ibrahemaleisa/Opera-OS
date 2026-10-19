"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/app/field";
import { EmptyState, Section } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { formObject } from "@/lib/form";
import { useI18n } from "@/lib/i18n/client";
import { archiveCustomFieldAction, saveCustomFieldAction } from "../actions";

interface Def { id: string; entityType: string; key: string; labelAr: string; labelEn: string; fieldType: string; options: string[]; required: boolean; projectId: string | null }

export function FieldsClient({ orgSlug, fields }: { orgSlug: string; fields: Def[] }) {
  const { m, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const save = useAction(saveCustomFieldAction, { orgSlug, onSuccess: () => setOpen(false) });
  const archive = useAction(archiveCustomFieldAction, { orgSlug });
  return (
    <>
      <Section title={`${m.org.customFields} (${fields.length})`} actions={<Button size="sm" onClick={() => setOpen(true)}><Plus /> {m.org.newField}</Button>}>
        {fields.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
          <ul className="divide-y">
            {fields.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div>
                  <div className="text-sm font-medium">{locale === "ar" ? f.labelAr : f.labelEn} {f.required && <span className="text-danger">*</span>}</div>
                  <div className="ltr-nums text-xs text-muted-foreground">{f.entityType} · {f.key} · {f.fieldType}{f.options.length ? ` · ${f.options.join(", ")}` : ""}{f.projectId ? " · project" : ""}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => archive.run({ id: f.id })}>{m.common.archive}</Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{m.org.newField}</DialogTitle></DialogHeader>
          <form className="grid gap-3" onSubmit={(e) => {
            e.preventDefault();
            const o = formObject(e.currentTarget);
            save.run({ ...o, options: String(o.options ?? "").split(",").map((s) => s.trim()).filter(Boolean), required: !!o.required } as never);
          }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label={m.org.entityType}>
                <NativeSelect name="entityType">{["PROJECT", "TASK", "RECIPIENT", "GUEST", "VENDOR"].map((x) => <option key={x}>{x}</option>)}</NativeSelect>
              </Field>
              <Field label={m.org.fieldType}>
                <NativeSelect name="fieldType">{["TEXT", "NUMBER", "DATE", "SELECT", "BOOLEAN"].map((x) => <option key={x}>{x}</option>)}</NativeSelect>
              </Field>
              <Field label={m.org.fieldKey} error={save.errorFor("key")} hint="camelCase"><Input name="key" required dir="ltr" pattern="[a-z][a-zA-Z0-9_]{1,40}" /></Field>
              <Field label={m.common.nameAr}><Input name="labelAr" required /></Field>
              <Field label={m.common.nameEn}><Input name="labelEn" required dir="ltr" /></Field>
            </div>
            <Field label={m.org.options}><Input name="options" /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="required" /> {m.common.required}</label>
            <DialogFooter><Button type="submit" disabled={save.pending}>{m.common.save}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
