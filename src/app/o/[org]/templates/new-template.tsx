"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/app/field";
import { useAction } from "@/hooks/use-action";
import { formObject } from "@/lib/form";
import { useI18n } from "@/lib/i18n/client";
import { createTemplateAction } from "./actions";

export function NewTemplateButton({ orgSlug, templates }: { orgSlug: string; templates: { id: string; name: string }[] }) {
  const { m } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { run, pending } = useAction(createTemplateAction, { orgSlug, onSuccess: (d) => router.push(`/o/${orgSlug}/templates/${d.id}`) });
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Plus /> {m.templates.newTemplate}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{m.templates.newTemplate}</DialogTitle></DialogHeader>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(formObject(e.currentTarget) as never); }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label={m.common.nameAr}><Input name="nameAr" required /></Field>
              <Field label={m.common.nameEn}><Input name="nameEn" required dir="ltr" /></Field>
            </div>
            <Field label={m.common.category}><NativeSelect name="category">{Object.entries(m.templates.categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Field>
            <Field label={m.templates.clone}><NativeSelect name="cloneFromId"><option value="">{m.common.none}</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</NativeSelect></Field>
            <DialogFooter><Button type="submit" disabled={pending}>{m.common.create}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
