"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/app/field";
import { useAction } from "@/hooks/use-action";
import { formObject } from "@/lib/form";
import { parseRiyadhDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { saveCampaignAction } from "@/app/o/[org]/delivery/actions";

export function CampaignSwitcher({ campaigns, current }: { campaigns: { id: string; name: string }[]; current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const { m } = useI18n();
  return (
    <NativeSelect className="h-8 w-64" value={current} aria-label={m.delivery.campaign} onChange={(e) => { const q = new URLSearchParams(sp.toString()); q.set("c", e.target.value); router.replace(`${pathname}?${q}`); }}>
      {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </NativeSelect>
  );
}

export function NewCampaignButton({ orgSlug, projectId }: { orgSlug: string; projectId: string }) {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const { run, pending } = useAction(saveCampaignAction, { orgSlug, onSuccess: () => setOpen(false) });
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus /> {m.delivery.newCampaign}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{m.delivery.newCampaign}</DialogTitle></DialogHeader>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const o = formObject(e.currentTarget); run({ projectId, name: String(o.name), invitationType: (o.invitationType as string) ?? null, deliveryDeadline: parseRiyadhDate(o.deadline as string, "23:59"), requireEvidence: !!o.requireEvidence, requireReceiverName: !!o.requireReceiverName, maxAttempts: Number(o.maxAttempts ?? 3) }); }}>
            <Field label={m.common.name} required><Input name="name" required /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={m.common.type}><Input name="invitationType" placeholder="VIP" /></Field>
              <Field label={m.delivery.deadline}><Input type="date" name="deadline" dir="ltr" /></Field>
              <Field label={m.delivery.maxAttempts}><NativeSelect name="maxAttempts" defaultValue="3">{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</NativeSelect></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requireEvidence" defaultChecked /> {m.delivery.requireEvidence}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requireReceiverName" defaultChecked /> {m.delivery.requireReceiver}</label>
            <DialogFooter><Button type="submit" disabled={pending}>{m.common.create}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
