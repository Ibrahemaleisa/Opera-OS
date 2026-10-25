"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
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
import { formatDateTime, formatPercent, formatRelative, parseRiyadhDateTime, toDateTimeInput } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { interpolate } from "@/lib/i18n";
import { ActionButton } from "@/components/app/action-button";
import { ConfirmAction } from "@/components/app/confirm-action";
import { ConflictNotice, type ConflictRow } from "@/components/app/conflict-notice";
import type { getDigitalCampaign } from "@/server/modules/digital/service";
import { VARIABLES } from "@/lib/digital-vars";
import { addAudienceAction, cancelCampaignAction, cancelRemainingSendsAction, launchCampaignAction, requestCampaignApprovalAction, resendMessageAction, resumeCampaignSendAction, saveDigitalCampaignAction, simulateReceiptAction } from "@/app/o/[org]/digital/actions";

type D = Awaited<ReturnType<typeof getDigitalCampaign>>;
type Inv = D["invitations"][number];
type Avail = D["available"][number];

/** The campaign form's fields, in form order (also the conflict comparison order). */
const CAMPAIGN_FIELDS = ["name", "channel", "subject", "bodyTemplate", "scheduledAt", "rsvpDeadline", "rsvpEnabled", "qrEnabled"] as const;
type CampaignField = (typeof CAMPAIGN_FIELDS)[number];
const DATE_FIELDS: readonly string[] = ["scheduledAt", "rsvpDeadline"];
/** Comparable form of a campaign field: date-times by the minute (what the form can hold), empty as "". */
function comparable(k: string, v: unknown): unknown {
  if (DATE_FIELDS.includes(k)) return v ? toDateTimeInput(v as string) : "";
  if (typeof v === "boolean") return v;
  return v === null || v === undefined ? "" : String(v);
}
const differs = (k: string, a: unknown, b: unknown) => comparable(k, a) !== comparable(k, b);

export function CampaignDetail({ orgSlug, projectId, data, currentUserId }: { orgSlug: string; projectId: string; data: D; currentUserId: string }) {
  const { m, fmt, dir } = useI18n();
  const dg = m.digital;
  const c = data.campaign;
  const editable = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED"].includes(c.status) && data.scope.manage;
  const [body, setBody] = useState(c.bodyTemplate ?? "");
  // an edit after the approval request voids the approval (the four-eyes check covers what is sent)
  const voided = (r: { approvalInvalidated?: unknown }) => {
    if (r.approvalInvalidated) toast.warning(dg.approvalVoided, { duration: 10_000 });
  };
  // edit conflicts (BUSINESS_RULES §6): the version to send once a conflict moved the user on, and the
  // stored values loaded by "Discard mine"
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const verRef = useRef<number | undefined>(undefined);
  const [stored, setStored] = useState<Record<string, unknown> | null>(null);
  const [formKey, setFormKey] = useState(0);
  const lc = { ...c, ...stored } as typeof c;
  const save = useAction(saveDigitalCampaignAction, {
    orgSlug,
    conflictUi: "inline",
    onSuccess: (r) => {
      verRef.current = undefined;
      setStored(null);
      voided(r);
    },
  });
  const readCampaignForm = (form: HTMLFormElement): Record<CampaignField, unknown> => {
    const fd = new FormData(form);
    return {
      name: String(fd.get("name")),
      channel: fd.get("channel"),
      subject: (fd.get("subject") as string) || null,
      bodyTemplate: body,
      scheduledAt: parseRiyadhDateTime(fd.get("scheduledAt") as string),
      rsvpDeadline: parseRiyadhDateTime(fd.get("rsvpDeadline") as string),
      rsvpEnabled: fd.get("rsvpEnabled") === "on",
      qrEnabled: fd.get("qrEnabled") === "on",
    };
  };
  const sendCampaign = (values: Record<string, unknown>, version: number | undefined) => save.run({ id: c.id, projectId, eventId: c.eventId, ...values, version } as never);
  const conflict = save.conflict;
  const fieldLabel: Record<CampaignField, string> = { name: m.common.name, channel: dg.channel, subject: dg.subject, bodyTemplate: dg.body, scheduledAt: dg.schedule, rsvpDeadline: dg.rsvpDeadline, rsvpEnabled: dg.rsvpEnabled, qrEnabled: dg.qrEnabled };
  const shown = (k: CampaignField, v: unknown): React.ReactNode => {
    if (typeof v === "boolean") return v ? m.common.yes : m.common.no;
    if (v === null || v === undefined || v === "") return m.common.conflict.empty;
    if (k === "channel") return m.enums.channel[v as keyof typeof m.enums.channel] ?? String(v);
    if (DATE_FIELDS.includes(k)) return formatDateTime(v as string, fmt);
    return String(v);
  };
  const conflictRows: ConflictRow[] = conflict
    ? CAMPAIGN_FIELDS.filter((k) => k in conflict.current && differs(k, conflict.current[k], (save.conflictInput as Record<string, unknown> | null)?.[k])).map((k) => ({ name: k, label: fieldLabel[k], theirs: shown(k, conflict.current[k]), yours: shown(k, (save.conflictInput as Record<string, unknown>)[k]) }))
    : [];
  const useTheirs = (k: string) => {
    const v = conflict?.current[k];
    if (k === "bodyTemplate") return setBody((v as string) ?? "");
    const el = formRef.current?.elements.namedItem(k);
    if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!v;
    else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = DATE_FIELDS.includes(k) ? (v ? toDateTimeInput(v as string) : "") : String(v ?? "");
  };
  /** Re-apply mine: the fields I changed on top of the stored ones, at the stored version. */
  const saveMine = () => {
    if (!conflict || !formRef.current) return;
    const now = readCampaignForm(formRef.current);
    const merged: Record<string, unknown> = {};
    for (const k of CAMPAIGN_FIELDS) merged[k] = differs(k, now[k], (lc as Record<string, unknown>)[k]) || !(k in conflict.current) ? now[k] : conflict.current[k];
    const v = typeof conflict.current.version === "number" ? conflict.current.version : undefined;
    verRef.current = v;
    save.clearConflict();
    sendCampaign(merged, v);
  };
  /** Discard mine: load what's stored now and continue from its version. */
  const discardMine = () => {
    if (!conflict) return;
    const cur = conflict.current;
    setStored(Object.fromEntries(CAMPAIGN_FIELDS.filter((k) => k in cur).map((k) => [k, cur[k]])));
    if ("bodyTemplate" in cur) setBody((cur.bodyTemplate as string) ?? "");
    verRef.current = typeof cur.version === "number" ? cur.version : undefined;
    setFormKey((n) => n + 1);
    save.clearConflict();
    router.refresh();
  };
  const add = useAction(addAudienceAction, { orgSlug, success: false, onSuccess: (r) => { toast.success(`+${r.added}`); voided(r); } });
  const request = useAction(requestCampaignApprovalAction, { orgSlug });
  const launch = useAction(launchCampaignAction, { orgSlug, success: dg.launched });
  const cancel = useAction(cancelCampaignAction, { orgSlug });
  const sim = useAction(simulateReceiptAction, { orgSlug, success: false });
  // stalled / late sends and messages of unknown outcome (BUSINESS_RULES §7.2, UX note 8)
  const resumeSend = useAction(resumeCampaignSendAction, { orgSlug, success: false, onSuccess: (r) => (r.resumed ? toast.success(dg.send.resumed) : toast.info(dg.send.busy)) });
  const cancelRemaining = useAction(cancelRemainingSendsAction, { orgSlug });
  const resend = useAction(resendMessageAction, { orgSlug, success: dg.send.resent });
  const unknownOutcome = data.invitations.filter((i) => i.lastError === "outcome_unknown").length;
  const sendState = data.send;
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
    { id: "err", header: "", cell: ({ row }) => row.original.lastError === "outcome_unknown" ? <span className="flex items-center gap-1.5 text-[11px] text-danger" data-testid="outcome-unknown"><AlertTriangle className="inline size-3" aria-hidden />{dg.send.unknownRow}{data.scope.send && <ActionButton variant="link" size="xs" className="h-auto px-0 text-[11px]" onClick={(e) => e.stopPropagation()} action={() => resend.run({ campaignId: data.campaign.id, invitationId: row.original.id })}>{dg.send.resend}</ActionButton>}</span> : row.original.lastError ? <span className="text-[11px] text-danger" title={row.original.lastError}><AlertTriangle className="inline size-3" /></span> : row.original.simulated && row.original.status === "SENT" && data.scope.manage ? <ActionButton variant="link" size="xs" className="h-auto px-0 text-[11px] text-violet" onClick={(e) => e.stopPropagation()} action={() => sim.run({ invitationId: row.original.id, status: "DELIVERED" })}><FlaskConical className="me-0.5 inline size-3" />{dg.simulateReceipt}</ActionButton> : null },
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
        <h2 className="text-lg font-medium">{c.name}</h2>
        <StatusBadge status={c.status} label={m.enums.campaignStatus[c.status]} />
        <span className="text-xs text-muted-foreground">{c.channel && m.enums.channel[c.channel]}</span>
        <div className="ms-auto flex flex-wrap gap-2">
          {c.qrEnabled && <Button asChild size="sm" variant="outline"><Link href={`/o/${orgSlug}/projects/${projectId}/digital/${c.id}/checkin`}><ScanLine /> {dg.checkInDesk}</Link></Button>}
          {data.scope.export && <Button asChild size="sm" variant="outline"><a href={`/api/o/${orgSlug}/exports/guests?campaignId=${c.id}`}><Download /> {dg.exportGuests}</a></Button>}
          {c.status === "DRAFT" && data.scope.manage && <Button size="sm" variant="outline" disabled={request.pending || !total} onClick={() => request.run({ campaignId: c.id, version: c.version })} data-testid="campaign-request-approval">{dg.requestApproval}</Button>}
          {c.status === "APPROVED" && data.scope.send && (
            <ConfirmAction
              trigger={<Button size="sm" disabled={launch.pending} data-testid="campaign-launch"><Rocket /> {dg.launch}</Button>}
              title={interpolate(m.common.confirmDialog.launchCampaignTitle, { name: c.name })}
              description={interpolate(c.scheduledAt && new Date(c.scheduledAt) > new Date() ? m.common.confirmDialog.launchCampaignScheduledBody : m.common.confirmDialog.launchCampaignBody, { n: total, channel: c.channel ? m.enums.channel[c.channel] : "" })}
              confirmLabel={dg.launch}
              onConfirm={() => launch.run({ campaignId: c.id, version: c.version })}
              testId="campaign-launch-dialog"
            />
          )}
          {["SCHEDULED", "SENDING", "ACTIVE"].includes(c.status) && data.scope.manage && (
            <ConfirmAction
              trigger={<Button size="sm" variant="ghost" className="text-danger" data-testid="campaign-cancel"><StopCircle /> {dg.cancel}</Button>}
              title={interpolate(m.common.confirmDialog.cancelCampaignTitle, { name: c.name })}
              description={m.common.confirmDialog.cancelCampaignBody}
              confirmLabel={dg.cancel}
              destructive
              onConfirm={() => cancel.run({ campaignId: c.id, version: c.version })}
              testId="campaign-cancel-confirm"
            />
          )}
        </div>
      </div>
      {(sendState.paused || sendState.stalled || sendState.late) && (
        <div role="status" data-testid="campaign-send-state" data-state={sendState.late ? "late" : sendState.stalled ? "stalled" : "paused"} className={`flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm ${sendState.paused ? "bg-info-soft text-info" : "bg-warning-soft text-warning"}`}>
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {sendState.late
              ? interpolate(dg.send.late, { time: c.scheduledAt ? formatDateTime(c.scheduledAt, fmt) : "—" })
              : sendState.stalled
                ? interpolate(dg.send.stalled, { n: sendState.attempts, done: sent, total })
                : interpolate(dg.send.paused, { time: formatRelative(sendState.nextAttemptAt, fmt), age: formatRelative(sendState.lastProgressAt, fmt) })}
          </span>
          {data.scope.send && (sendState.paused || sendState.stalled) && (
            <ActionButton size="sm" variant="outline" action={() => resumeSend.run({ campaignId: c.id })} data-testid="campaign-resume-send">{dg.send.resume}</ActionButton>
          )}
          {data.scope.send && sendState.stalled && (
            <ConfirmAction
              trigger={<Button size="sm" variant="ghost" className="text-danger" data-testid="campaign-cancel-remaining"><StopCircle /> {dg.send.cancelRemaining}</Button>}
              title={dg.send.cancelRemainingTitle}
              description={dg.send.cancelRemainingBody}
              confirmLabel={dg.send.cancelRemaining}
              destructive
              onConfirm={() => cancelRemaining.run({ campaignId: c.id, version: c.version })}
              testId="campaign-cancel-remaining-confirm"
            />
          )}
        </div>
      )}
      {unknownOutcome > 0 && <p role="status" className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning" data-testid="campaign-outcome-unknown"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{interpolate(dg.send.unknown, { n: unknownOutcome })}</p>}
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
          {conflict && <ConflictNotice className="mx-4 mt-4" conflict={conflict} rows={conflictRows} onUseTheirs={useTheirs} onSaveMine={saveMine} onDiscardMine={discardMine} pending={save.pending} />}
          <form
            key={formKey}
            ref={formRef}
            className="grid gap-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (conflict) return saveMine();
              sendCampaign(readCampaignForm(e.currentTarget), verRef.current ?? c.version);
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={m.common.name}><Input name="name" defaultValue={lc.name} disabled={!editable} /></Field>
              <Field label={dg.channel}><NativeSelect name="channel" defaultValue={lc.channel ?? "EMAIL"} disabled={!editable}>{Object.entries(m.enums.channel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Field>
              <Field label={dg.subject} className="sm:col-span-2" error={save.errorFor("subject")}><Input name="subject" defaultValue={lc.subject ?? ""} disabled={!editable} /></Field>
            </div>
            <Field label={dg.body} hint={`${dg.variables}: ${VARIABLES.map((v) => `{{${v}}}`).join("  ")}`}>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} disabled={!editable} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={dg.schedule} hint={dg.sendNow}><Input type="datetime-local" name="scheduledAt" defaultValue={toDateTimeInput(lc.scheduledAt)} disabled={!editable} dir="ltr" /></Field>
              <Field label={dg.rsvpDeadline}><Input type="datetime-local" name="rsvpDeadline" defaultValue={toDateTimeInput(lc.rsvpDeadline)} disabled={!editable} dir="ltr" /></Field>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" name="rsvpEnabled" defaultChecked={lc.rsvpEnabled} disabled={!editable} /> {dg.rsvpEnabled}</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="qrEnabled" defaultChecked={lc.qrEnabled} disabled={!editable} /> {dg.qrEnabled}</label>
            </div>
            {editable && <div><Button type="submit" size="sm" disabled={save.pending}>{m.common.save}</Button></div>}
          </form>
        </Section>
        <div className="grid content-start gap-4">
          <Section title={dg.preview}>
            <div className="p-4"><div className="rounded-2xl rounded-ss-sm bg-brand-soft p-3 text-[13px] leading-relaxed whitespace-pre-wrap">{data.preview ?? <span className="text-muted-foreground">{m.common.emptyTitle}</span>}</div></div>
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
            bulkActions={(rows, clear) => <ActionButton variant="link" size="xs" className="h-auto px-0 text-xs font-medium text-primary" data-testid="audience-add" action={() => add.run({ campaignId: c.id, recipientIds: rows.map((r) => r.id) }).then((r) => r.ok && clear())}>{dg.addAudience}</ActionButton>}
          />
        </Section>
      )}
    </div>
  );
}
