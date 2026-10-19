"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, Download, FlaskConical, Rocket, ScanLine, ShieldCheck, StopCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/app/data-table";
import { Field, NativeSelect } from "@/components/app/field";
import { Breadcrumbs, Section, Stat } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { ApprovalsBox } from "@/app/o/[org]/tasks/[taskId]/task-detail";
import { useAction } from "@/hooks/use-action";
import { formatPercent, parseRiyadhDateTime, toDateTimeInput } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import type { getDigitalCampaign } from "@/server/modules/digital/service";
import { VARIABLES } from "@/lib/digital-vars";
import { addAudienceAction, cancelCampaignAction, launchCampaignAction, requestCampaignApprovalAction, saveDigitalCampaignAction, simulateReceiptAction } from "@/app/o/[org]/digital/actions";

type D = Awaited<ReturnType<typeof getDigitalCampaign>>;
type Inv = D["invitations"][number];
type Avail = D["available"][number];

export function CampaignDetail({ orgSlug, projectId, data, currentUserId }: { orgSlug: string; projectId: string; data: D; currentUserId: string }) {
  const { m, fmt, dir } = useI18n();
  const dg = m.digital;
  const c = data.campaign;
  const editable = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED"].includes(c.status) && data.scope.manage;
  const [body, setBody] = useState(c.bodyTemplate ?? "");
  const save = useAction(saveDigitalCampaignAction, { orgSlug });
  const add = useAction(addAudienceAction, { orgSlug, success: false, onSuccess: (r) => toast.success(`+${r.added}`) });
  const request = useAction(requestCampaignApprovalAction, { orgSlug });
  const launch = useAction(launchCampaignAction, { orgSlug, success: dg.launched });
  const cancel = useAction(cancelCampaignAction, { orgSlug });
  const sim = useAction(simulateReceiptAction, { orgSlug, success: false });
  const total = data.invitations.length;
  const sent = (data.counts.SENT ?? 0) + (data.counts.DELIVERED ?? 0) + (data.counts.READ ?? 0);
  const responded = (data.rsvp.ATTENDING ?? 0) + (data.rsvp.DECLINED ?? 0) + (data.rsvp.MAYBE ?? 0);

  const invCols = useMemo<ColumnDef<Inv, unknown>[]>(() => [
    { accessorKey: "code", header: m.delivery.registry.code, cell: ({ getValue }) => <span className="ltr-nums font-mono text-xs text-muted-foreground">{getValue() as string}</span> },
    { accessorKey: "name", header: m.common.name, cell: ({ row }) => <div><div className="font-medium">{row.original.name}</div><div className="text-[11px] text-muted-foreground">{row.original.organization}</div></div> },
    { accessorKey: "address", header: dg.channel, cell: ({ getValue }) => <span className="ltr-nums text-xs">{(getValue() as string) || "—"}</span> },
    { accessorKey: "status", header: m.common.status, cell: ({ row }) => <span className="flex items-center gap-1"><StatusBadge status={row.original.status} label={m.enums.messageStatus[row.original.status as keyof typeof m.enums.messageStatus]} />{row.original.simulated && <span className="rounded bg-violet-soft px-1 text-[9px] text-violet">{m.common.simulation}</span>}</span> },
    { accessorKey: "rsvpStatus", header: dg.rsvp, cell: ({ row }) => row.original.rsvpStatus ? <StatusBadge status={row.original.rsvpStatus} label={m.enums.rsvp[row.original.rsvpStatus as keyof typeof m.enums.rsvp]} /> : <span className="text-xs text-muted-foreground">—</span> },
    { accessorKey: "checkedInAt", header: dg.checkedIn, cell: ({ row }) => row.original.checkedInAt ? <ShieldCheck className="size-4 text-success" /> : null },
    { id: "err", header: "", cell: ({ row }) => row.original.lastError ? <span className="text-[11px] text-danger" title={row.original.lastError}><AlertTriangle className="inline size-3" /></span> : row.original.simulated && row.original.status === "SENT" && data.scope.manage ? <button className="text-[11px] text-violet hover:underline" onClick={(e) => { e.stopPropagation(); sim.run({ invitationId: row.original.id, status: "DELIVERED" }); }}><FlaskConical className="me-0.5 inline size-3" />{dg.simulateReceipt}</button> : null },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [m]);
  const availCols = useMemo<ColumnDef<Avail, unknown>[]>(() => [
    { accessorKey: "code", header: m.delivery.registry.code, cell: ({ getValue }) => <span className="ltr-nums font-mono text-xs text-muted-foreground">{getValue() as string}</span> },
    { accessorKey: "name", header: m.common.name },
    { accessorKey: "organization", header: m.projects.client },
    { accessorKey: "vipTier", header: m.delivery.registry.tier },
    { accessorKey: "hasAddress", header: dg.channel, cell: ({ getValue }) => (getValue() ? <span className="text-xs text-success">✓</span> : <span className="text-xs text-warning">{dg.noAddress}</span>) },
  ], [m, dg]);

  return (
    <div className="grid gap-4">
      <Breadcrumbs dir={dir} items={[{ label: dg.title, href: `/o/${orgSlug}/projects/${projectId}/digital` }, { label: c.name }]} />
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{c.name}</h2>
        <StatusBadge status={c.status} label={m.enums.campaignStatus[c.status]} />
        <span className="text-xs text-muted-foreground">{c.channel && m.enums.channel[c.channel]}</span>
        <div className="ms-auto flex flex-wrap gap-2">
          {c.qrEnabled && <Button asChild size="sm" variant="outline"><Link href={`/o/${orgSlug}/projects/${projectId}/digital/${c.id}/checkin`}><ScanLine /> {dg.checkInDesk}</Link></Button>}
          {data.scope.export && <Button asChild size="sm" variant="outline"><a href={`/api/o/${orgSlug}/exports/guests?campaignId=${c.id}`}><Download /> {dg.exportGuests}</a></Button>}
          {c.status === "DRAFT" && data.scope.manage && <Button size="sm" variant="outline" disabled={request.pending || !total} onClick={() => request.run({ campaignId: c.id })} data-testid="campaign-request-approval">{dg.requestApproval}</Button>}
          {c.status === "APPROVED" && data.scope.send && <Button size="sm" disabled={launch.pending} onClick={() => launch.run({ campaignId: c.id })} data-testid="campaign-launch"><Rocket /> {dg.launch}</Button>}
          {["SCHEDULED", "SENDING", "ACTIVE"].includes(c.status) && data.scope.manage && <Button size="sm" variant="ghost" className="text-danger" onClick={() => cancel.run({ campaignId: c.id })}><StopCircle /> {dg.cancel}</Button>}
        </div>
      </div>
      <p className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${data.providerMode === "LIVE" ? "bg-success-soft text-success" : "bg-violet-soft text-violet"}`}><FlaskConical className="mt-0.5 size-3.5 shrink-0" />{data.providerMode === "LIVE" ? dg.liveBanner : dg.simulationBanner}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label={m.common.total} value={total} />
        <Stat label={dg.sent} value={sent} />
        <Stat label={dg.delivered} value={(data.counts.DELIVERED ?? 0) + (data.counts.READ ?? 0)} tone="success" />
        <Stat label={dg.failed} value={data.counts.FAILED ?? 0} tone={data.counts.FAILED ? "danger" : "default"} />
        <Stat label={dg.suppressed} value={data.counts.SUPPRESSED ?? 0} />
        <Stat label={dg.attending} value={data.rsvp.ATTENDING ?? 0} tone="success" />
        <Stat label={dg.conversion} value={formatPercent(sent ? responded / sent : null, fmt)} hint={`${dg.declined}: ${data.rsvp.DECLINED ?? 0}`} />
        <Stat label={dg.checkedIn} value={data.invitations.filter((i) => i.checkedInAt).length} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Section title={dg.body}>
          <form
            className="grid gap-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              save.run({ id: c.id, projectId, name: String(fd.get("name")), channel: fd.get("channel") as never, subject: (fd.get("subject") as string) || null, bodyTemplate: body, scheduledAt: parseRiyadhDateTime(fd.get("scheduledAt") as string), rsvpEnabled: fd.get("rsvpEnabled") === "on", rsvpDeadline: parseRiyadhDateTime(fd.get("rsvpDeadline") as string), qrEnabled: fd.get("qrEnabled") === "on", eventId: c.eventId });
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={m.common.name}><Input name="name" defaultValue={c.name} disabled={!editable} /></Field>
              <Field label={dg.channel}><NativeSelect name="channel" defaultValue={c.channel ?? "EMAIL"} disabled={!editable}>{Object.entries(m.enums.channel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Field>
              <Field label={dg.subject} className="sm:col-span-2" error={save.errorFor("subject")}><Input name="subject" defaultValue={c.subject ?? ""} disabled={!editable} /></Field>
            </div>
            <Field label={dg.body} hint={`${dg.variables}: ${VARIABLES.map((v) => `{{${v}}}`).join("  ")}`}>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} disabled={!editable} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={dg.schedule} hint={dg.sendNow}><Input type="datetime-local" name="scheduledAt" defaultValue={toDateTimeInput(c.scheduledAt)} disabled={!editable} dir="ltr" /></Field>
              <Field label={dg.rsvpDeadline}><Input type="datetime-local" name="rsvpDeadline" defaultValue={toDateTimeInput(c.rsvpDeadline)} disabled={!editable} dir="ltr" /></Field>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" name="rsvpEnabled" defaultChecked={c.rsvpEnabled} disabled={!editable} /> {dg.rsvpEnabled}</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="qrEnabled" defaultChecked={c.qrEnabled} disabled={!editable} /> {dg.qrEnabled}</label>
            </div>
            {editable && <div><Button type="submit" size="sm" disabled={save.pending}>{m.common.save}</Button></div>}
          </form>
        </Section>
        <div className="grid content-start gap-4">
          <Section title={dg.preview}>
            <div className="p-4"><div className="rounded-2xl rounded-ss-sm bg-jade-soft p-3 text-[13px] leading-relaxed whitespace-pre-wrap">{data.preview ?? <span className="text-muted-foreground">{m.common.emptyTitle}</span>}</div></div>
          </Section>
          <Section title={m.projects.approvals} description={dg.approvalNote}>
            {data.approvals.length ? <ApprovalsBox orgSlug={orgSlug} approvals={data.approvals} canDecide={data.scope.approve && data.approvals.every((a) => a.requestedById !== currentUserId)} nameOf={() => "—"} /> : <p className="px-4 py-3 text-xs text-muted-foreground">{m.common.none}</p>}
          </Section>
        </div>
      </div>

      <Section title={`${dg.audience} (${total})`}>
        <DataTable data={data.invitations} columns={invCols} getRowId={(r) => r.id} />
      </Section>
      {editable && data.available.length > 0 && (
        <Section title={`${dg.available} (${data.available.length})`} actions={<Button size="sm" variant="outline" disabled={add.pending} onClick={() => add.run({ campaignId: c.id, recipientIds: data.available.map((a) => a.id) })} data-testid="audience-add-all">{dg.addAudience} ({data.available.length})</Button>}>
          <DataTable
            data={data.available}
            columns={availCols}
            getRowId={(r) => r.id}
            selectable
            pageSize={25}
            bulkActions={(rows, clear) => <button className="text-xs font-medium hover:underline" data-testid="audience-add" onClick={() => add.run({ campaignId: c.id, recipientIds: rows.map((r) => r.id) }).then(clear)}>{dg.addAudience}</button>}
          />
        </Section>
      )}
    </div>
  );
}
