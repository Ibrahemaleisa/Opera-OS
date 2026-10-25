"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/app/field";
import { EmptyState, ProgressBar, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formatPercent } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { saveDigitalCampaignAction } from "@/app/o/[org]/digital/actions";

interface C { id: string; name: string; status: string; channel: string | null; total: number; sent: number; attending: number; responded: number; project: { id: string; code: string; name: string }; projectId: string }

export function CampaignList({ orgSlug, projectId, campaigns, canCreate }: { orgSlug: string; projectId?: string; campaigns: C[]; canCreate: boolean }) {
  const { m, fmt } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const save = useAction(saveDigitalCampaignAction, { orgSlug, onSuccess: (d) => router.push(`/o/${orgSlug}/projects/${projectId}/digital/${d.id}`) });
  const dg = m.digital;
  return (
    <>
      <Section title={`${dg.title} (${campaigns.length})`} actions={canCreate && projectId && <Button size="sm" onClick={() => setOpen(true)}><Plus /> {dg.newCampaign}</Button>}>
        {campaigns.length === 0 ? <EmptyState icon={<Send />} title={m.common.emptyTitle} /> : (
          <ul className="divide-y">
            {campaigns.map((c) => (
              <li key={c.id}>
                <Link href={`/o/${orgSlug}/projects/${c.projectId}/digital/${c.id}`} className="grid gap-2 px-4 py-3 hover:bg-muted/40 md:grid-cols-[1fr_140px_200px_120px] md:items-center">
                  <div><div className="text-[13px] font-medium">{c.name}</div><div className="text-[11px] text-muted-foreground"><span className="ltr-nums">{c.project.code}</span> · {c.channel ? m.enums.channel[c.channel as keyof typeof m.enums.channel] : "—"}</div></div>
                  <StatusBadge status={c.status} label={m.enums.campaignStatus[c.status as keyof typeof m.enums.campaignStatus]} />
                  <div><ProgressBar value={c.total ? (c.sent / c.total) * 100 : 0} /><div className="tabular mt-1 text-[11px] text-muted-foreground">{dg.sent}: {c.sent}/{c.total}</div></div>
                  <div className="tabular text-xs">{dg.attending}: {c.attending} <span className="text-muted-foreground">({formatPercent(c.sent ? c.responded / c.sent : null, fmt)})</span></div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{dg.newCampaign}</DialogTitle></DialogHeader>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); save.run({ projectId: projectId!, name: String(fd.get("name")), channel: fd.get("channel") as never, subject: (fd.get("subject") as string) || null, bodyTemplate: "{{honorific}} {{name}}\nيسرنا دعوتكم لحضور {{event_name}} بتاريخ {{event_date}}.\nللتأكيد: {{rsvp_link}}", rsvpEnabled: true, qrEnabled: true }); }}>
            <Field label={m.common.name} required><Input name="name" required /></Field>
            <Field label={dg.channel}><NativeSelect name="channel">{Object.entries(m.enums.channel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Field>
            <Field label={dg.subject} hint={m.enums.channel.EMAIL}><Input name="subject" /></Field>
            <DialogFooter><Button type="submit" disabled={save.pending}>{m.common.create}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
