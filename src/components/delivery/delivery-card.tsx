"use client";

import { useState } from "react";
import { AlertCircle, ExternalLink, MapPin, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Attachments, uploadFile } from "@/components/app/attachments";
import { CommentsThread, type CommentRow } from "@/components/app/comments";
import { Field, NativeSelect } from "@/components/app/field";
import { Breadcrumbs, KV, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formatDateTime, parseRiyadhDateTime } from "@/lib/format";
import { telHref } from "@/lib/phone";
import { useI18n } from "@/lib/i18n/client";
import { TimeAgo } from "@/components/app/time-ago";
import type { getDelivery } from "@/server/modules/delivery/service";
import { FAILURE_REASONS, TRANSITIONS } from "@/server/modules/delivery/state-machine";
import { escalateAction, updateStatusAction } from "@/app/o/[org]/delivery/actions";
import { useAssign, type Agent } from "./delivery-table";
import { toast } from "sonner";

type Data = Awaited<ReturnType<typeof getDelivery>>;

export function DeliveryCard({ orgSlug, projectId, data, agents, comments, members }: { orgSlug: string; projectId: string; data: Data; agents: Agent[]; comments: CommentRow[]; members: { id: string; name: string }[] }) {
  const { m, fmt, dir, tk } = useI18n();
  const d = data.delivery;
  const r = d.recipient;
  const name = (id: string | null) => (id ? data.users[id] ?? "—" : "—");
  const [target, setTarget] = useState<string>("");
  const [evidence, setEvidence] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const status = useAction(updateStatusAction, { orgSlug, onSuccess: () => { setTarget(""); setEvidence([]); } });
  const escalate = useAction(escalateAction, { orgSlug });
  const { assign, dialog } = useAssign(orgSlug, projectId);
  const allowed = TRANSITIONS[d.status].filter((s) => s !== "ASSIGNED");
  const dl = m.delivery;
  return (
    <div className="grid gap-4">
      <Breadcrumbs dir={dir} items={[{ label: dl.cards, href: `/o/${orgSlug}/projects/${projectId}/delivery/cards?c=${data.campaign.id}` }, { label: d.trackingCode }]} />
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="ltr-nums font-mono text-lg font-medium">{d.trackingCode}</h2>
        <StatusBadge status={d.status} label={m.enums.deliveryStatus[d.status]} />
        {d.escalatedAt && <span className="flex items-center gap-1 text-xs text-danger"><AlertCircle className="size-3.5" /> {dl.escalated}: {d.escalationNote}</span>}
        <span className="text-xs text-muted-foreground">{data.campaign.name}</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid content-start gap-4">
          <Section title={dl.recipient} description={r.masked ? m.common.sensitiveHidden : undefined}>
            <dl className="px-4 py-2">
              <KV label={m.common.name}><span className="font-medium">{r.honorific} {r.nameAr}</span>{r.nameEn && <div className="text-xs text-muted-foreground" dir="ltr">{r.nameEn}</div>}</KV>
              <KV label={m.org.jobTitle}>{r.jobTitle ?? "—"} {r.organizationName && <span className="text-muted-foreground">· {r.organizationName}</span>}</KV>
              <KV label={dl.registry.tier}>{r.vipTier ?? "—"}</KV>
              <KV label={m.common.phone}>{r.mobile ? (r.masked ? <span className="ltr-nums">{r.mobile}</span> : <a className="ltr-nums text-primary hover:underline" href={telHref(r.mobile)}><Phone className="me-1 inline size-3" />{r.mobile}</a>) : "—"}</KV>
              <KV label={m.common.address}>{r.address ?? "—"}<div className="text-xs text-muted-foreground">{[r.city, r.district].filter(Boolean).join(" · ")}</div></KV>
              {r.mapsUrl && <KV label={m.org.mapsUrl}><a href={r.mapsUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary hover:underline"><MapPin className="size-3" /> {dl.navigate} <ExternalLink className="size-3" /></a></KV>}
              <KV label={m.delivery.field.window}>{r.preferredWindow ?? "—"}</KV>
              <KV label={m.delivery.field.instructions}>{r.deliveryInstructions ?? "—"}</KV>
            </dl>
          </Section>

          {(data.scope.update || data.scope.dispatch) && allowed.length > 0 && (
            <Section title={m.common.status}>
              <div className="grid gap-3 p-4">
                <div className="flex flex-wrap gap-2">
                  {allowed.map((s) => (
                    <Button key={s} size="sm" variant={target === s ? "default" : "outline"} onClick={() => setTarget(s)} data-testid={`to-${s}`}>{m.enums.deliveryStatus[s]}</Button>
                  ))}
                </div>
                {target && (
                  <form
                    className="grid gap-3 rounded-md border p-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      status.run({ deliveryId: d.id, to: target as never, version: d.version, reason: (fd.get("reason") as never) || null, note: (fd.get("note") as string) || null, receivedByName: (fd.get("receivedByName") as string) || null, receivedByRelation: (fd.get("receivedByRelation") as string) || null, scheduledFor: parseRiyadhDateTime(fd.get("scheduledFor") as string), evidenceIds: evidence, source: "WEB" });
                    }}
                  >
                    {(target === "FAILED_ATTEMPT" || target === "RETURNED") && (
                      <Field label={dl.failureReason} required={target === "FAILED_ATTEMPT"}>
                        <NativeSelect name="reason" required={target === "FAILED_ATTEMPT"}><option value="">—</option>{FAILURE_REASONS.map((x) => <option key={x} value={x}>{dl.reasons[x]}</option>)}</NativeSelect>
                      </Field>
                    )}
                    {target === "RESCHEDULED" && <Field label={dl.scheduleFor} required><Input type="datetime-local" name="scheduledFor" required dir="ltr" /></Field>}
                    {target === "DELIVERED" && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={dl.receivedBy} required={data.campaign.config.requireReceiverName}><Input name="receivedByName" required={data.campaign.config.requireReceiverName} /></Field>
                          <Field label={dl.relation}><Input name="receivedByRelation" /></Field>
                        </div>
                        <Field label={dl.evidence} required={data.campaign.config.requireEvidence} hint={evidence.length ? `${evidence.length} ✓` : undefined} htmlFor={`evidence-${d.id}`}>
                          <input id={`evidence-${d.id}`} type="file" accept="image/*,application/pdf" capture="environment" disabled={busy} onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            setBusy(true);
                            const res = await uploadFile(orgSlug, { file: f, entityType: "DELIVERY", entityId: d.id, kind: "EVIDENCE" });
                            setBusy(false);
                            if (res.ok && res.data) setEvidence((x) => [...x, res.data!.id]); else toast.error(tk(res.error ?? "errors.unexpected"));
                          }} className="text-xs" />
                        </Field>
                      </>
                    )}
                    <Field label={m.common.notes}><Textarea name="note" rows={2} /></Field>
                    {status.fieldErrors.evidence && <p className="text-xs text-danger">{dl.evidenceRequired}</p>}
                    <div><Button type="submit" size="sm" disabled={status.pending || busy} data-testid="status-submit">{m.common.confirm}</Button></div>
                  </form>
                )}
              </div>
            </Section>
          )}

          <Section title={dl.statusHistory}>
            <ol className="relative ms-5 border-s py-3">
              {d.events.map((e) => (
                <li key={e.id} className="relative mb-3 ps-5 pe-4 text-[13px]">
                  <span className="absolute -start-[5px] top-1.5 size-2.5 rounded-full border-2 border-card bg-primary" />
                  <div className="flex flex-wrap items-center gap-2">
                    {e.fromStatus && <><StatusBadge status={e.fromStatus} label={m.enums.deliveryStatus[e.fromStatus]} dot={false} /> →</>}
                    <StatusBadge status={e.toStatus} label={m.enums.deliveryStatus[e.toStatus]} />
                    {e.source !== "WEB" && <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{e.source}</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">{name(e.actorId)} · <span className="tabular">{formatDateTime(e.createdAt, fmt)}</span>{e.reason && ` · ${(dl.reasons as Record<string, string>)[e.reason] ?? e.reason}`}</div>
                  {e.note && <div className="text-xs">{e.note}</div>}
                </li>
              ))}
            </ol>
          </Section>
          <Section title={m.tasks.comments}>
            <CommentsThread orgSlug={orgSlug} projectId={projectId} entityType="DELIVERY" entityId={d.id} comments={comments} members={members} />
          </Section>
        </div>
        <div className="grid content-start gap-4">
          <Section title={m.common.details}>
            <dl className="px-4 py-2">
              <KV label={dl.agent}>{d.agent ? (d.agent.nameAr ?? d.agent.name) : "—"}</KV>
              <KV label={dl.batch}>{d.batch ? `${d.batch.code} · ${d.batch.name}` : "—"}</KV>
              <KV label={dl.attempts}>{d.attemptsCount} / {data.campaign.config.maxAttempts}</KV>
              <KV label={m.common.priority}><StatusBadge status={d.priority} label={m.enums.priority[d.priority]} /></KV>
              {d.scheduledFor && <KV label={dl.scheduleFor}>{formatDateTime(d.scheduledFor, fmt)}</KV>}
              {d.deliveredAt && <KV label={dl.delivered}>{formatDateTime(d.deliveredAt, fmt)} · {d.receivedByName}{d.receivedByRelation && ` (${d.receivedByRelation})`}</KV>}
              {d.failureReason && <KV label={dl.failureReason}>{(dl.reasons as Record<string, string>)[d.failureReason] ?? d.failureReason}</KV>}
            </dl>
            {data.scope.dispatch && (
              <div className="grid gap-2 border-t p-4">
                <NativeSelect value="" onChange={(e) => e.target.value && assign([d.id], e.target.value === "__none" ? null : e.target.value)} aria-label={dl.assignTo}>
                  <option value="">{dl.assignTo}…</option>
                  {d.agentId && <option value="__none">{dl.unassign}</option>}
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.open}/{a.capacity})</option>)}
                </NativeSelect>
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const note = String(new FormData(e.currentTarget).get("note") ?? ""); if (note.trim().length >= 3) escalate.run({ deliveryId: d.id, note }); }}>
                  <Input name="note" placeholder={dl.escalationNote} className="h-8" />
                  <Button size="sm" variant="outline" type="submit" disabled={escalate.pending}>{dl.escalate}</Button>
                </form>
              </div>
            )}
          </Section>
          <Section title={dl.attempts}>
            <ul className="divide-y">
              {d.attempts.map((a) => (
                <li key={a.id} className="px-4 py-2 text-xs">
                  <div className="flex items-center justify-between"><span className="font-medium">#{a.attemptNo} · {name(a.agentId)}</span><StatusBadge status={a.outcome === "DELIVERED" ? "DELIVERED" : a.outcome === "FAILED" ? "FAILED_ATTEMPT" : "RETURNED"} label={a.outcome === "DELIVERED" ? m.enums.deliveryStatus.DELIVERED : a.outcome === "FAILED" ? m.enums.deliveryStatus.FAILED_ATTEMPT : m.enums.deliveryStatus.RETURNED} /></div>
                  <div className="tabular text-muted-foreground">{formatDateTime(a.occurredAt, fmt)}{a.failureReason && ` · ${(dl.reasons as Record<string, string>)[a.failureReason]}`}</div>
                </li>
              ))}
              {!d.attempts.length && <li className="px-4 py-4 text-center text-xs text-muted-foreground">{m.common.none}</li>}
            </ul>
          </Section>
          <Section title={dl.evidence}>
            <Attachments orgSlug={orgSlug} entityType="DELIVERY" entityId={d.id} items={data.attachments} canUpload={data.scope.update} />
          </Section>
          <Section title={m.common.history}>
            <ul className="divide-y">
              {d.assignments.map((a) => (
                <li key={a.id} className="px-4 py-2 text-xs">{name(a.agentId)} <span className="text-muted-foreground">· {name(a.assignedById)} · <TimeAgo date={a.assignedAt} />{a.unassignedAt && ` → $<TimeAgo date={a.unassignedAt} />`}</span></li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
      {dialog}
    </div>
  );
}
