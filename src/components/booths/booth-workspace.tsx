"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Check, ChevronLeft, CircleDashed, FileSignature, Plus, Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Attachments } from "@/components/app/attachments";
import { Breadcrumbs, EmptyState, KV, Section, Stat } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { FormDialog, enumOptions, type FieldDef } from "@/components/app/form-dialog";
import { useAction } from "@/hooks/use-action";
import { ActionButton } from "@/components/app/action-button";
import { ConfirmAction } from "@/components/app/confirm-action";
import { DateText } from "@/components/app/date-text";
import { interpolate } from "@/lib/i18n";
import { formatMoney, formatNumber } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { getBooth } from "@/server/modules/booths/service";
import { createRevisionAction, deleteBoqItemAction, recordInspectionAction, saveBoothAction, saveBoqItemAction, saveSnagAction, setBoothStageAction, setSnagStatusAction, signHandoverAction, submitRevisionAction } from "@/app/o/[org]/booths/actions";

type D = Awaited<ReturnType<typeof getBooth>>;
const TABS = ["overview", "design", "boq", "inspections", "snags", "handover"] as const;
type Tab = (typeof TABS)[number];
type Dlg = { kind: "booth" | "revision" | "boq" | "inspection" | "snag"; values?: Record<string, unknown> | null } | null;
const STAGES = ["BRIEF", "DESIGN", "CLIENT_APPROVAL", "PROCUREMENT", "FABRICATION", "LOGISTICS", "INSTALLATION", "INSPECTION", "HANDOVER", "LIVE", "DISMANTLING", "CLOSED"] as const;

export function BoothWorkspace({ orgSlug, data }: { orgSlug: string; data: D }) {
  const { m, fmt, dir, tk } = useI18n();
  const t = m.booths;
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>((TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "overview");
  const [dlg, setDlg] = useState<Dlg>(null);
  const [signedBy, setSignedBy] = useState("");
  const b = data.booth;
  const can = data.canManage;
  const close = () => setDlg(null);
  const money = (v: number) => formatMoney(v, { ...fmt, currency: data.project.currency });
  const gateLabel = (key: string) => tk(key);
  const person = (id: string | null) => data.people.find((p) => p.id === id)?.name ?? "—";

  const saveBooth = useAction(saveBoothAction, { orgSlug, onSuccess: close, conflictUi: "inline" });
  const stage = useAction(setBoothStageAction, { orgSlug });
  const newRev = useAction(createRevisionAction, { orgSlug, onSuccess: close });
  const submitRev = useAction(submitRevisionAction, { orgSlug });
  const saveBoq = useAction(saveBoqItemAction, { orgSlug, onSuccess: close });
  const delBoq = useAction(deleteBoqItemAction, { orgSlug });
  const inspect = useAction(recordInspectionAction, { orgSlug, onSuccess: close });
  const saveSnag = useAction(saveSnagAction, { orgSlug, onSuccess: close });
  const snag = useAction(setSnagStatusAction, { orgSlug, success: false });
  const sign = useAction(signHandoverAction, { orgSlug });

  const go = (next: Tab) => {
    setTab(next);
    const u = new URL(window.location.href);
    u.searchParams.set("tab", next);
    router.replace(u.pathname + u.search, { scroll: false });
  };
  const idx = STAGES.indexOf(b.stage);
  const openSnags = data.snags.filter((s) => ["OPEN", "IN_PROGRESS"].includes(s.status));

  const fields: Record<NonNullable<Dlg>["kind"], FieldDef[]> = {
    booth: [
      { name: "name", label: m.common.name, required: true, wide: true },
      { name: "kind", label: m.common.type, type: "select", options: enumOptions(t.kind) },
      { name: "permitStatus", label: t.permit, type: "select", options: enumOptions(t.permitStatus) },
      { name: "exhibition", label: t.exhibition },
      { name: "hall", label: t.hall },
      { name: "standNumber", label: t.stand, ltr: true },
      { name: "widthM", label: t.width, type: "number", min: 0 },
      { name: "depthM", label: t.depth, type: "number", min: 0 },
      { name: "heightM", label: t.height, type: "number", min: 0 },
      { name: "siteAccessAt", label: t.siteAccess, type: "datetime" },
      { name: "buildStartAt", label: t.buildStart, type: "datetime" },
      { name: "handoverAt", label: t.handover, type: "datetime" },
      { name: "dismantleAt", label: t.dismantle, type: "datetime" },
      { name: "brief", label: t.brief, type: "textarea" },
    ],
    revision: [{ name: "title", label: m.common.title, required: true, wide: true }, { name: "notes", label: m.common.notes, type: "textarea" }],
    boq: [
      { name: "code", label: t.code, required: true, ltr: true },
      { name: "category", label: t.category, type: "select", options: enumOptions(t.boqCategory) },
      { name: "description", label: t.description, required: true, wide: true },
      { name: "unit", label: t.unit },
      { name: "quantity", label: t.qty, type: "number", min: 0, required: true },
      { name: "unitCost", label: t.unitCost, type: "number", min: 0, required: true },
      { name: "vendorId", label: t.vendor, type: "select", empty: "—", options: data.vendors.map((v) => ({ value: v.id, label: v.name })) },
      { name: "committedCost", label: t.committed, type: "number", min: 0 },
      { name: "actualCost", label: t.actual, type: "number", min: 0 },
      { name: "status", label: m.common.status, type: "select", options: enumOptions(t.boqStatus) },
    ],
    inspection: [
      { name: "type", label: m.common.type, type: "select", options: enumOptions(t.inspectionType) },
      { name: "result", label: t.result.PASS + " / " + t.result.FAIL, type: "select", options: enumOptions(t.result) },
      { name: "notes", label: m.common.notes, type: "textarea" },
    ],
    snag: [
      { name: "title", label: m.common.title, required: true, wide: true },
      { name: "location", label: t.location },
      { name: "severity", label: m.events.severity, type: "select", options: enumOptions(m.enums.severity) },
      { name: "assigneeId", label: t.assignee, type: "select", empty: "—", options: data.people.map((p) => ({ value: p.id, label: p.name })) },
    ],
  };
  const submit = (kind: NonNullable<Dlg>["kind"], v: Record<string, unknown>) => {
    const id = dlg?.values?.id as string | undefined;
    if (kind === "booth") saveBooth.run({ ...v, id: b.id, projectId: data.project.id, version: (v.version as number | undefined) ?? b.version } as never);
    if (kind === "revision") newRev.run({ ...v, boothId: b.id } as never);
    if (kind === "boq") saveBoq.run({ ...v, id, boothId: b.id, unit: v.unit ?? "unit", committedCost: v.committedCost ?? 0, actualCost: v.actualCost ?? 0 } as never);
    if (kind === "inspection") inspect.run({ ...v, boothId: b.id } as never);
    if (kind === "snag") saveSnag.run({ ...v, id, boothId: b.id } as never);
  };
  const errorFor = (f: string) => saveBooth.errorFor(f) ?? saveBoq.errorFor(f) ?? inspect.errorFor(f) ?? saveSnag.errorFor(f) ?? newRev.errorFor(f);
  const pending = saveBooth.pending || newRev.pending || saveBoq.pending || inspect.pending || saveSnag.pending;
  const titles = { booth: b.name, revision: t.newRevision, boq: t.newBoq, inspection: t.recordInspection, snag: t.newSnag };

  return (
    <div className="grid gap-4">
      <Breadcrumbs dir={dir} items={[{ label: m.nav.booths, href: `/o/${orgSlug}/projects/${data.project.id}/production` }, { label: b.name }]} />
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium">{b.name}</h2>
        <span className="text-xs text-muted-foreground">{t.kind[b.kind as keyof typeof t.kind]}{b.standNumber ? ` · ${b.standNumber}` : ""}{b.hall ? ` · ${b.hall}` : ""}</span>
        <StatusBadge status={idx >= STAGES.indexOf("HANDOVER") ? "DONE" : "IN_PROGRESS"} label={m.enums.boothStage[b.stage]} />
        {can && <Button size="sm" variant="outline" className="ms-auto" onClick={() => setDlg({ kind: "booth", values: b as unknown as Record<string, unknown> })}>{m.common.edit}</Button>}
      </div>

      {/* stage stepper */}
      <ol className="flex gap-1 overflow-x-auto pb-1" aria-label={t.stage}>
        {STAGES.map((s, i) => (
          <li key={s} className={cn("flex min-w-[88px] flex-1 flex-col gap-1 text-[10px]", i <= idx ? "text-foreground" : "text-muted-foreground")}>
            <span className={cn("h-1.5 rounded-full", i < idx ? "bg-primary" : i === idx ? "bg-primary/60" : "bg-muted")} />
            <span className={cn(i === idx && "font-medium")}>{m.enums.boothStage[s]}</span>
          </li>
        ))}
      </ol>
      {can && data.nextStage && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 text-xs">
          <div className="grid gap-1">
            <span className="font-medium">{t.nextGates}: {m.enums.boothStage[data.nextStage]}</span>
            {data.nextGates.length === 0 ? <span className="flex items-center gap-1 text-success"><Check className="size-3.5" /> {t.allClear}</span> : (
              <ul className="flex flex-wrap gap-x-4 gap-y-1">{data.nextGates.map((g) => <li key={g} className="flex items-center gap-1 text-warning" data-testid="gate-unmet"><CircleDashed className="size-3.5" /> {gateLabel(g)}</li>)}</ul>
            )}
          </div>
          <div className="ms-auto flex gap-2">
            {idx > 0 && (
              <ConfirmAction
                trigger={<Button size="sm" variant="ghost" title={t.moveBack} aria-label={t.moveBack}><ChevronLeft className="rtl:rotate-180" /></Button>}
                title={interpolate(m.common.confirmDialog.moveBackTitle, { name: m.enums.boothStage[STAGES[idx - 1]] })}
                field={{ type: "textarea", label: t.reasonPrompt, required: true }}
                confirmLabel={t.moveBack}
                onConfirm={(reason) => stage.run({ boothId: b.id, stage: STAGES[idx - 1], reason, version: b.version })}
                testId="booth-move-back"
              />
            )}
            <Button size="sm" disabled={stage.pending || data.nextGates.length > 0} onClick={() => stage.run({ boothId: b.id, stage: data.nextStage!, version: b.version })} data-testid="booth-advance">{t.advance}: {m.enums.boothStage[data.nextStage]}</Button>
          </div>
        </div>
      )}

      <nav className="-mb-px flex gap-1 overflow-x-auto border-b" role="tablist">
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => go(k)} data-testid={`booth-tab-${k}`} className={cn("flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 text-[13px] text-muted-foreground hover:text-foreground", tab === k && "border-primary font-medium text-foreground")}>
            {t.tabs[k]}
            {k === "snags" && openSnags.length > 0 && <span className="tabular rounded-full bg-warning px-1.5 text-[10px] text-white">{openSnags.length}</span>}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid content-start gap-4">
            {data.showCosts && (
              <div className="grid grid-cols-3 gap-3">
                <Stat label={t.estimate} value={money(data.totals.estimate)} />
                <Stat label={t.committed} value={money(data.totals.committed)} />
                <Stat label={t.actual} value={money(data.totals.actual)} tone={data.totals.actual > data.totals.estimate && data.totals.estimate > 0 ? "danger" : "default"} />
              </div>
            )}
            <Section title={t.brief}><p className="p-4 text-sm whitespace-pre-wrap">{b.brief || <span className="text-muted-foreground">—</span>}</p></Section>
            <Section title={t.files}><div className="p-4"><Attachments orgSlug={orgSlug} entityType="BOOTH" entityId={b.id} items={data.boothFiles} canUpload={can} /></div></Section>
          </div>
          <Section title={m.common.details}>
            <dl className="grid gap-2 p-4 text-sm">
              <KV label={t.exhibition}>{b.exhibition ?? "—"}</KV>
              <KV label={t.size}><span className="ltr-nums">{[b.widthM, b.depthM, b.heightM].map((x) => x ?? "—").join(" × ")}</span></KV>
              <KV label={t.permit}><StatusBadge status={b.permitStatus === "APPROVED" ? "APPROVED" : b.permitStatus === "REJECTED" ? "REJECTED" : b.permitStatus === "SUBMITTED" ? "SUBMITTED" : "PENDING"} label={t.permitStatus[b.permitStatus as keyof typeof t.permitStatus]} /></KV>
              <KV label={t.siteAccess}><DateText value={b.siteAccessAt} format="datetime" /></KV>
              <KV label={t.buildStart}><DateText value={b.buildStartAt} format="datetime" /></KV>
              <KV label={t.handover}><DateText value={b.handoverAt} format="datetime" /></KV>
              <KV label={t.dismantle}><DateText value={b.dismantleAt} format="datetime" /></KV>
            </dl>
          </Section>
        </div>
      )}

      {tab === "design" && (
        <Section title={`${t.revisions} (${data.revisions.length})`} actions={can && <Button size="sm" onClick={() => setDlg({ kind: "revision" })}><Plus /> {t.newRevision}</Button>}>
          {data.revisions.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
            <ul className="divide-y">
              {data.revisions.map((r) => (
                <li key={r.id} className="grid gap-3 px-4 py-4" data-testid="revision">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tabular rounded bg-muted px-1.5 text-xs font-medium">R{r.revisionNo}</span>
                    <span className="text-[13px] font-medium">{r.title}</span>
                    <StatusBadge status={r.status} label={m.enums.revisionStatus[r.status]} />
                    {r.approval?.decisionComment && <span className="text-[11px] text-muted-foreground">“{r.approval.decisionComment}”</span>}
                    {can && ["DRAFT", "REJECTED"].includes(r.status) && (
                      <div className="ms-auto flex gap-2">
                        <Button size="xs" variant="outline" disabled={submitRev.pending || r.attachments.length === 0} title={r.attachments.length ? undefined : t.uploadDesign} onClick={() => submitRev.run({ revisionId: r.id, approverType: "INTERNAL" })} data-testid="revision-submit-internal"><Send /> {t.submitInternal}</Button>
                        <Button size="xs" disabled={submitRev.pending || r.attachments.length === 0} title={r.attachments.length ? undefined : t.uploadDesign} onClick={() => submitRev.run({ revisionId: r.id, approverType: "CLIENT" })}><Send /> {t.submitToClient}</Button>
                      </div>
                    )}
                  </div>
                  {r.notes && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{r.notes}</p>}
                  <Attachments orgSlug={orgSlug} entityType="REVISION" entityId={r.id} items={r.attachments} canUpload={can && ["DRAFT", "REJECTED"].includes(r.status)} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {tab === "boq" && (
        <Section title={`${t.boq} (${data.boq.length})`} actions={can && <Button size="sm" onClick={() => setDlg({ kind: "boq", values: { category: "FABRICATION", unit: "unit", status: "PLANNED" } })}><Plus /> {t.newBoq}</Button>}>
          {data.boq.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="border-b bg-muted/40 text-[11px] text-muted-foreground"><tr>{[t.code, t.description, t.category, t.qty, t.unitCost, t.estimate, t.committed, t.actual, m.common.status, ""].map((h, i) => <th key={i} className="px-3 py-2 text-start font-medium">{h}</th>)}</tr></thead>
                <tbody className="divide-y">
                  {data.boq.map((x) => (
                    <tr key={x.id} className={cn(can && "cursor-pointer hover:bg-muted/40")} onClick={() => can && setDlg({ kind: "boq", values: x as unknown as Record<string, unknown> })}>
                      <td className="ltr-nums px-3 py-2 font-mono text-xs">{x.code}</td>
                      <td className="px-3 py-2">{x.description}<div className="text-[11px] text-muted-foreground">{data.vendors.find((v) => v.id === x.vendorId)?.name}</div></td>
                      <td className="px-3 py-2 text-xs">{t.boqCategory[x.category as keyof typeof t.boqCategory] ?? x.category}</td>
                      <td className="tabular px-3 py-2">{formatNumber(x.quantity, fmt)} <span className="text-[11px] text-muted-foreground">{x.unit}</span></td>
                      <td className="tabular px-3 py-2">{money(x.unitCost)}</td>
                      <td className="tabular px-3 py-2 font-medium">{money(x.total)}</td>
                      <td className="tabular px-3 py-2">{money(x.committedCost)}</td>
                      <td className={cn("tabular px-3 py-2", x.actualCost > x.total && "text-danger")}>{money(x.actualCost)}</td>
                      <td className="px-3 py-2"><StatusBadge status={x.status === "INSTALLED" ? "DONE" : x.status === "PLANNED" ? "PLANNED" : "IN_PROGRESS"} label={t.boqStatus[x.status as keyof typeof t.boqStatus]} /></td>
                      <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                        {can && x.committedCost === 0 && x.actualCost === 0 && (
                          <ConfirmAction
                            trigger={<Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-danger" aria-label={`${m.common.delete} — ${x.description}`}><Trash2 className="size-3.5" /></Button>}
                            title={interpolate(m.common.confirmDialog.deleteItemTitle, { name: x.description })}
                            description={m.common.confirmDialog.irreversible}
                            confirmLabel={m.common.delete}
                            destructive
                            onConfirm={() => delBoq.run({ id: x.id, boothId: b.id })}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t bg-muted/30 font-medium"><tr><td colSpan={5} className="px-3 py-2">{m.common.total}</td><td className="tabular px-3 py-2">{money(data.totals.estimate)}</td><td className="tabular px-3 py-2">{money(data.totals.committed)}</td><td className="tabular px-3 py-2">{money(data.totals.actual)}</td><td colSpan={2} /></tr></tfoot>
              </table>
            </div>
          )}
        </Section>
      )}

      {tab === "inspections" && (
        <Section title={`${t.inspections} (${data.inspections.length})`} actions={can && <Button size="sm" onClick={() => setDlg({ kind: "inspection", values: { type: "STRUCTURAL", result: "PASS" } })} data-testid="record-inspection"><Plus /> {t.recordInspection}</Button>}>
          {data.inspections.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
            <ul className="divide-y">
              {data.inspections.map((i) => (
                <li key={i.id} className="grid gap-1 px-4 py-3 md:grid-cols-[160px_100px_1fr_160px] md:items-center">
                  <span className="text-[13px] font-medium">{t.inspectionType[i.type as keyof typeof t.inspectionType] ?? i.type}</span>
                  <StatusBadge status={i.result === "PASS" ? "DONE" : i.result === "FAIL" ? "FAILED" : "WARNING"} label={t.result[i.result as keyof typeof t.result]} />
                  <span className="text-xs text-muted-foreground">{i.notes}</span>
                  <span className="text-[11px] text-muted-foreground">{person(i.inspectedById)} · <DateText value={i.inspectedAt} format="datetime" /></span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {tab === "snags" && (
        <Section title={`${t.snags} (${openSnags.length}/${data.snags.length})`} actions={can && <Button size="sm" onClick={() => setDlg({ kind: "snag", values: { severity: "MEDIUM" } })}><Plus /> {t.newSnag}</Button>}>
          {data.snags.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
            <ul className="divide-y">
              {data.snags.map((s) => (
                <li key={s.id} className={cn("grid gap-2 px-4 py-3 md:grid-cols-[90px_1fr_140px_auto] md:items-center", s.status === "VERIFIED" && "opacity-60")} data-testid="snag" data-status={s.status}>
                  <StatusBadge status={s.severity === "HIGH" || s.severity === "CRITICAL" ? "FAILED" : s.severity === "MEDIUM" ? "WARNING" : "PENDING"} label={m.enums.severity[s.severity]} />
                  <div><div className="text-[13px] font-medium">{s.title}</div><div className="text-[11px] text-muted-foreground">{[s.location, person(s.assigneeId)].filter((x) => x && x !== "—").join(" · ")}</div></div>
                  <StatusBadge status={s.status === "VERIFIED" ? "DONE" : s.status === "FIXED" ? "REVIEW" : s.status} label={t.snagStatus[s.status as keyof typeof t.snagStatus]} />
                  {can && (
                    <div className="flex gap-1">
                      {["OPEN", "IN_PROGRESS"].includes(s.status) && <ActionButton size="sm" variant="outline" action={() => snag.run({ id: s.id, status: "FIXED" })}>{t.markFixed}</ActionButton>}
                      {s.status === "FIXED" && <><ActionButton size="sm" action={() => snag.run({ id: s.id, status: "VERIFIED" })}><Check /> {t.verify}</ActionButton><ActionButton size="sm" variant="ghost" action={() => snag.run({ id: s.id, status: "OPEN" })}>{t.reopen}</ActionButton></>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {tab === "handover" && (
        <Section title={t.readiness}>
          <div className="grid gap-4 p-4">
            <ul className="grid gap-2 text-sm">
              {data.readiness.map((r) => (
                <li key={r.key} className={cn("flex items-center gap-2", r.ok ? "text-success" : "text-muted-foreground")} data-testid="handover-check" data-ok={r.ok}>
                  {r.ok ? <Check className="size-4" /> : <X className="size-4 text-danger" />} {gateLabel(r.key)}
                </li>
              ))}
            </ul>
            {b.handoverSignedAt ? (
              <p className="flex items-center gap-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success"><FileSignature className="size-4" /> {t.signed}: {b.handoverSignedBy} · <DateText value={b.handoverSignedAt} /></p>
            ) : can && (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); sign.run({ boothId: b.id, signedBy, version: b.version }); }}>
                <label className="grid gap-1 text-xs">{t.signedBy}<Input value={signedBy} onChange={(e) => setSignedBy(e.target.value)} required minLength={2} className="w-64" /></label>
                <Button type="submit" disabled={sign.pending || !data.readiness.every((r) => r.ok)} data-testid="sign-handover"><FileSignature /> {t.signHandover}</Button>
              </form>
            )}
          </div>
        </Section>
      )}

      {dlg && (
        <FormDialog open onOpenChange={(o) => !o && close()} title={dlg.values?.id && dlg.kind !== "booth" ? String(dlg.values.code ?? dlg.values.title ?? titles[dlg.kind]) : titles[dlg.kind]} fields={fields[dlg.kind]} values={dlg.values} onSubmit={(v) => submit(dlg.kind, v)} pending={pending} errorFor={errorFor} testId={`form-${dlg.kind}`} conflict={dlg.kind === "booth" ? saveBooth.conflict : null} onConflictResolved={saveBooth.clearConflict} />
      )}
    </div>
  );
}
