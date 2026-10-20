"use client";

import { useState } from "react";
import { CheckCircle2, Circle, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Attachments } from "@/components/app/attachments";
import { FormDialog } from "@/components/app/form-dialog";
import { Breadcrumbs, EmptyState, ProgressBar, Section, Stat } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formatDate, formatMoney, formatPercent } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import type { portalProject } from "@/server/modules/portal/service";
import { decideApprovalAction } from "@/app/o/[org]/projects/actions";
import { createChangeRequestAction } from "../../actions";

type D = Awaited<ReturnType<typeof portalProject>>;

export function PortalProject({ orgSlug, data }: { orgSlug: string; data: D }) {
  const { m, fmt, dir } = useI18n();
  const t = m.portal;
  const [comments, setComments] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const decide = useAction(decideApprovalAction, { orgSlug });
  const request = useAction(createChangeRequestAction, { orgSlug, onSuccess: () => setOpen(false) });
  const p = data.project;
  const pendingMine = data.approvals.filter((a) => a.status === "PENDING" && a.mine);
  return (
    <div className="grid gap-5">
      <Breadcrumbs dir={dir} items={[{ label: t.projects, href: `/portal/${orgSlug}` }, { label: p.code }]} />
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-medium">{p.name}</h1>
        <StatusBadge status={p.status} label={m.enums.projectStatus[p.status]} />
        <Button size="sm" variant="outline" className="ms-auto" onClick={() => setOpen(true)} data-testid="new-change-request"><MessageSquarePlus /> {t.newRequest}</Button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t.progress} value={formatPercent(data.progress.ratio, fmt)} hint={`${data.progress.done}/${data.progress.total} · ${t.progressHint}`} />
        <Stat label={t.pending} value={pendingMine.length} tone={pendingMine.length ? "warning" : "default"} />
        <Stat label={t.event} value={p.eventStartAt ? <span className="ltr-nums text-base">{formatDate(p.eventStartAt, fmt)}</span> : "—"} />
        <Stat label={t.requests} value={data.requests.filter((r) => ["OPEN", "UNDER_REVIEW"].includes(r.status)).length} />
      </div>

      {pendingMine.length > 0 && (
        <Section title={`${t.pending} (${pendingMine.length})`}>
          <ul className="divide-y">
            {pendingMine.map((a) => (
              <li key={a.id} className="grid gap-2 px-4 py-4" data-testid="portal-approval">
                <div className="font-medium">{a.title}</div>
                {a.description && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{a.description}</p>}
                {data.files.some((f) => f.entityId === a.entityId) && <Attachments orgSlug={orgSlug} entityType={a.entityType} entityId={a.entityId} items={data.files.filter((f) => f.entityId === a.entityId)} canUpload={false} />}
                {data.canApprove ? (
                  <div className="grid gap-2">
                    <Textarea rows={2} placeholder={t.commentHint} value={comments[a.id] ?? ""} onChange={(e) => setComments((c) => ({ ...c, [a.id]: e.target.value }))} />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={decide.pending} onClick={() => decide.run({ approvalId: a.id, decision: "APPROVED", comment: comments[a.id] || null })} data-testid="portal-approve">{t.approve}</Button>
                      <Button size="sm" variant="outline" disabled={decide.pending || !comments[a.id]?.trim()} onClick={() => decide.run({ approvalId: a.id, decision: "REJECTED", comment: comments[a.id] })} data-testid="portal-reject">{t.reject}</Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t.milestones}>
          {data.milestones.length === 0 ? <EmptyState title={m.common.none} /> : (
            <ul className="grid gap-2 p-4">
              {data.milestones.map((x) => (
                <li key={x.id} className="flex items-center gap-2 text-sm">{x.status === "DONE" ? <CheckCircle2 className="size-4 text-success" /> : <Circle className="size-4 text-muted-foreground" />}<span className="flex-1">{x.title}</span><span className="ltr-nums text-xs text-muted-foreground">{x.dueAt ? formatDate(x.dueAt, fmt) : ""}</span></li>
              ))}
            </ul>
          )}
        </Section>
        <Section title={t.workItems} description={t.progressHint}>
          {data.tasks.length === 0 ? <EmptyState title={m.common.none} /> : (
            <ul className="grid max-h-80 gap-2 overflow-y-auto p-4" data-testid="portal-tasks">
              {data.tasks.map((x) => (
                <li key={x.id} className="flex items-center gap-2 text-sm" data-done={x.done}>{x.done ? <CheckCircle2 className="size-4 text-success" /> : <Circle className="size-4 text-muted-foreground" />}<span className="flex-1">{x.title}</span><span className="text-[11px] text-muted-foreground">{x.done ? t.completed : t.upcoming}</span></li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {(data.delivery || data.rsvp) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.delivery && (
            <Section title={t.delivery}>
              <div className="grid gap-3 p-4">
                <ProgressBar value={(data.delivery.delivered / data.delivery.total) * 100} tone="success" />
                <div className="grid grid-cols-3 gap-2 text-center text-xs"><div><div className="tabular text-lg font-medium">{data.delivery.delivered}/{data.delivery.total}</div>{t.delivered}</div><div><div className="tabular text-lg font-medium">{data.delivery.inProgress}</div>{t.inProgress}</div><div><div className="tabular text-lg font-medium">{data.delivery.issues}</div>{t.issues}</div></div>
              </div>
            </Section>
          )}
          {data.rsvp && (
            <Section title={t.rsvp}>
              <div className="grid grid-cols-4 gap-2 p-4 text-center text-xs">
                {([["attending", data.rsvp.attending], ["declined", data.rsvp.declined], ["maybe", data.rsvp.maybe], ["awaiting", data.rsvp.pending]] as const).map(([k, v]) => <div key={k}><div className="tabular text-lg font-medium">{v}</div>{t[k]}</div>)}
              </div>
            </Section>
          )}
        </div>
      )}

      {data.booths.length > 0 && (
        <Section title={t.booths}>
          <ul className="divide-y">{data.booths.map((b) => <li key={b.id} className="flex items-center gap-2 px-4 py-2.5 text-sm"><span className="flex-1">{b.name}</span><StatusBadge status={b.handoverSignedAt ? "DONE" : "IN_PROGRESS"} label={m.enums.boothStage[b.stage]} /></li>)}</ul>
        </Section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t.files}><div className="p-4"><Attachments orgSlug={orgSlug} entityType="PROJECT" entityId={p.id} items={data.files} canUpload={false} /></div></Section>
        <Section title={t.requests}>
          {data.requests.length === 0 ? <EmptyState title={m.common.none} /> : (
            <ul className="divide-y">
              {data.requests.map((r) => (
                <li key={r.id} className="grid gap-1 px-4 py-3" data-testid="change-request">
                  <div className="flex items-center gap-2"><span className="flex-1 text-sm font-medium">{r.title}</span><StatusBadge status={r.status === "ACCEPTED" ? "APPROVED" : r.status === "DECLINED" ? "REJECTED" : r.status === "UNDER_REVIEW" ? "REVIEW" : "OPEN"} label={t.requestStatus[r.status as keyof typeof t.requestStatus]} /></div>
                  <p className="text-xs text-muted-foreground">{r.description}</p>
                  {r.response && <p className="rounded bg-muted px-2 py-1 text-xs">{t.response}: {r.response}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {data.approvals.some((a) => a.status !== "PENDING") && (
        <Section title={t.approvals}>
          <ul className="divide-y">{data.approvals.filter((a) => a.status !== "PENDING").map((a) => <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm"><span className="flex-1">{a.title}</span>{a.decisionComment && <span className="text-xs text-muted-foreground">“{a.decisionComment}”</span>}<StatusBadge status={a.status} label={m.enums.approvalStatus[a.status]} /></li>)}</ul>
        </Section>
      )}
      {data.changeOrders.length > 0 && (
        <Section title={t.changeOrders}>
          <ul className="divide-y">{data.changeOrders.map((c) => <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm"><span className="ltr-nums font-mono text-xs text-muted-foreground">{c.code}</span><span className="flex-1">{c.title}</span><span className="tabular text-xs">{formatMoney(c.amountDelta, fmt)}</span><StatusBadge status={c.status} label={m.enums.approvalStatus[c.status]} /></li>)}</ul>
        </Section>
      )}

      <FormDialog open={open} onOpenChange={setOpen} title={t.newRequest} fields={[{ name: "title", label: m.common.title, required: true, wide: true }, { name: "description", label: m.common.description, type: "textarea", required: true }]} extra={{ projectId: p.id }} onSubmit={(v) => request.run(v as never)} pending={request.pending} errorFor={request.errorFor} testId="form-change-request" />
    </div>
  );
}
