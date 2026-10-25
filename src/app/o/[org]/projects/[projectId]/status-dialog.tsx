"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Field } from "@/components/app/field";
import { ActionButton } from "@/components/app/action-button";
import { GapMark } from "@/components/brand/gap-mark";
import { StatusRing } from "@/components/brand/status-ring";
import { PanelHeader } from "@/components/operations/primitives";
import { useAction } from "@/hooks/use-action";
import { formatMoney, parseRiyadhDate } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { ImpactRow, LifecycleTarget, StatusImpact } from "@/server/modules/projects/lifecycle";
import { previewStatusAction, setProjectStatusAction } from "../actions";

export type MoveKind = LifecycleTarget | "resume" | "reopen";

/** Which copy a move uses: cancel / close / hold / complete keep their own; resume and reopen are named. */
export function moveKind(from: string, to: LifecycleTarget): MoveKind {
  if (from === "ON_HOLD" && to !== "CANCELLED") return "resume";
  if ((from === "CLOSED" || from === "CANCELLED") || (from === "COMPLETED" && to === "ACTIVE")) return "reopen";
  return to;
}

const REASON_MIN = 10;

/**
 * The impact dialog for cancel, close, hold, complete, resume and reopen (BUSINESS_RULES §1.4 LC
 * rule 4, UX note 1): the preview's automatic / listed / unchanged rows, the close gates with the
 * override path, the reason, and for cancel the client notice. The counts load before the primary
 * button is enabled; a status that changed meanwhile refreshes the preview and keeps the reason.
 */
export function StatusImpactDialog({ orgSlug, projectId, code, from, target, onOpenChange }: { orgSlug: string; projectId: string; code: string; from: string; target: LifecycleTarget; onOpenChange: (o: boolean) => void }) {
  const { m } = useI18n();
  const L = m.projects.lifecycle;
  const labels = m.enums.projectStatus as Record<string, string>;
  const [impact, setImpact] = useState<StatusImpact | null>(null);
  const [failed, setFailed] = useState(false);
  const [reason, setReason] = useState("");
  const [notifyClient, setNotifyClient] = useState(true);
  const [resumeOn, setResumeOn] = useState("");
  const [overriding, setOverriding] = useState(false);
  const [changedTo, setChangedTo] = useState<string | null>(null);
  const preview = useAction(previewStatusAction, { orgSlug, success: false, refresh: false });
  const change = useAction(setProjectStatusAction, { orgSlug, conflictUi: "inline", onSuccess: () => onOpenChange(false) });
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const fetchImpact = () =>
    preview.run({ id: projectId, status: target }).then((r) => {
      if (r.ok) setImpact(r.data);
      else setFailed(true);
    });
  const reload = () => {
    setFailed(false);
    setImpact(null);
    void fetchImpact();
  };
  // the dialog is mounted per opening (keyed by target), so the preview loads once on mount
  useEffect(() => {
    void fetchImpact();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  const kind = moveKind(from, target);
  const key = (kind === "resume" || kind === "reopen" ? kind : target) as keyof typeof L.title;
  const title = interpolate((L.title as Record<string, string>)[key] ?? L.title.other, { code });
  const consequence = (L.consequence as Record<string, string>)[key] ?? L.consequence.other;
  const confirmLabel = (L.confirm as Record<string, string>)[key] ?? L.confirm.other;
  const openGates = impact?.gates.filter((g) => !g.ok) ?? [];
  const closing = target === "CLOSED";
  const needsReason = !!impact && (impact.reasonRequired || (closing && overriding));
  const reasonOk = reason.trim().length >= REASON_MIN;
  const blocked = (impact?.blocking.length ?? 0) > 0;
  const disabled = !impact || !impact.allowed || blocked || (closing && openGates.length > 0 && (!overriding || !impact.override.allowed)) || (needsReason && !reasonOk) || change.pending;

  const submit = async () => {
    if (!impact) return;
    const r = await change.run({ id: projectId, status: target, version: impact.version, reason: reason.trim() || null, ...(target === "CANCELLED" ? { notifyClient } : {}), ...(target === "ON_HOLD" && resumeOn ? { resumeOn: parseRiyadhDate(resumeOn) } : {}) });
    // the status moved meanwhile: say so, refresh the preview, keep the reason
    if (!r.ok && r.conflict) {
      setChangedTo(String(r.conflict.current.status ?? ""));
      change.clearConflict();
      reload();
    }
  };

  const rowsOf = (mode: ImpactRow["mode"]) => impact?.rows.filter((r) => r.mode === mode && (r.count > 0 || mode === "auto")).filter((r) => r.count > 0) ?? [];
  const rowText = (r: ImpactRow) => interpolate((L.rows as Record<string, string>)[r.key] ?? r.key, { n: r.count });

  const auto = rowsOf("auto");
  const listed = rowsOf("listed");
  const unchanged = rowsOf("unchanged");
  const gateLabel = (k: string) => (L.gate as Record<string, string>)[k] ?? k;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90dvh,48rem)] flex-col gap-0 p-0 sm:max-w-2xl max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none" data-testid="project-status-dialog">
        <DialogHeader className="border-b px-5 pt-5 pb-3">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{consequence}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-5 py-4">
          {changedTo && <Alert className="border-warning/40 bg-warning-soft text-warning" data-testid="impact-status-changed">{interpolate(L.statusChanged, { status: labels[changedTo] ?? changedTo })}</Alert>}
          {failed && (
            <Alert variant="destructive" className="flex flex-wrap items-center justify-between gap-2">
              <span>{L.previewFailed}</span>
              <Button size="sm" variant="ghost" onClick={reload}>{m.errors.retry}</Button>
            </Alert>
          )}
          {!impact && !failed && (
            <div className="grid gap-2" aria-busy="true" aria-label={L.loading}>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}
          {impact && (
            <>
              {impact.blocking.length > 0 && !closing && (
                <section>
                  <PanelHeader title={L.blockedTitle} as="h3" />
                  <ul className="divide-y">
                    {impact.blocking.map((g) => (
                      <li key={`${g.gate}-${g.key}`} className="flex items-center gap-2 py-2 text-[13px]" data-testid={`impact-gate-${g.key}`}>
                        <GapMark size={14} />
                        <span className="flex-1">{gateLabel(g.key)}</span>
                        <span className="tabular text-xs text-muted-foreground">{interpolate(L.gateOpen, { n: g.count })}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-muted-foreground">{L.notOverridable}</p>
                </section>
              )}
              {closing && (
                <section>
                  <PanelHeader title={L.gates} as="h3" />
                  <ul className="divide-y">
                    {impact.gates.map((g) => (
                      <li key={g.gate} className="flex items-center gap-2 py-2 text-[13px]" data-testid={`impact-gate-${g.gate}`}>
                        {g.ok ? <StatusRing state="complete" value={1} size={14} /> : <GapMark size={14} />}
                        <span className="flex-1">{gateLabel(g.key)}</span>
                        {!g.ok && (
                          <span className="text-end text-xs text-muted-foreground">
                            <span className="tabular">{interpolate(L.gateOpen, { n: g.count })}</span>
                            {!g.overridable && <span className="block text-danger">{L.notOverridable}</span>}
                            {g.overridable && g.needs && impact.override.missing.includes(g.needs) && <span className="block text-warning">{L.needsFinance}</span>}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {openGates.length > 0 && impact.override.allowed && !overriding && (
                    <button type="button" className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline" onClick={() => { setOverriding(true); setTimeout(() => reasonRef.current?.focus(), 0); }} data-testid="impact-override">
                      {L.override}
                    </button>
                  )}
                  {overriding && <p className="mt-2 text-xs text-muted-foreground">{L.overrideHint}</p>}
                </section>
              )}
              {auto.length > 0 && (!closing || overriding) && (
                <section>
                  <PanelHeader title={L.auto} as="h3" />
                  <RowList rows={auto} mode="auto" text={rowText} />
                </section>
              )}
              {listed.length > 0 && (
                <section>
                  <PanelHeader title={L.listed} as="h3" />
                  <RowList rows={listed} mode="listed" text={rowText} />
                </section>
              )}
              {unchanged.length > 0 && (
                <section>
                  <PanelHeader title={L.unchanged} as="h3" />
                  <RowList rows={unchanged} mode="unchanged" text={rowText} />
                </section>
              )}
              {target === "CANCELLED" && impact.clientRecipients.length > 0 && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={notifyClient} onChange={(e) => setNotifyClient(e.target.checked)} data-testid="impact-notify-client" />
                  <span>
                    {L.notifyClient}
                    <span className="block text-xs text-muted-foreground">{interpolate(L.notifyClientHint, { n: impact.clientRecipients.length })}</span>
                  </span>
                </label>
              )}
              {target === "ON_HOLD" && (
                <Field label={L.resumeOn}>
                  <Input type="date" value={resumeOn} onChange={(e) => setResumeOn(e.target.value)} dir="ltr" className="max-w-48" />
                </Field>
              )}
              {needsReason && (
                <Field label={L.reason} required hint={L.reasonHint} error={change.errorFor("reason")}>
                  <Textarea ref={reasonRef} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} data-testid="impact-reason" />
                </Field>
              )}
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-col-reverse gap-2 border-t bg-card px-5 py-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{m.common.cancel}</Button>
          <ActionButton variant={target === "CANCELLED" ? "destructive" : "default"} disabled={disabled || change.pending} action={submit} data-testid="impact-confirm">
            {confirmLabel}
          </ActionButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One group of impact rows: automatic (dot), listed for a person (gap mark, items), or unchanged (muted). */
function RowList({ rows, mode, text }: { rows: ImpactRow[]; mode: ImpactRow["mode"]; text: (r: ImpactRow) => string }) {
  const { m, fmt } = useI18n();
  const L = m.projects.lifecycle;
  return (
    <ul className="divide-y">
      {rows.map((r) => (
        <li key={r.key} className="py-2 text-[13px]" data-testid={`impact-row-${r.key}`}>
          <div className={cn("flex items-start gap-2", mode === "unchanged" && "text-muted-foreground")}>
            {mode === "listed" ? <GapMark size={14} className="mt-0.5 shrink-0" /> : <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", mode === "auto" ? "bg-primary" : "bg-muted-foreground/50")} />}
            <span className="tabular">{text(r)}</span>
          </div>
          {r.restricted && r.count > 0 && <div className="ms-5 text-xs text-muted-foreground">{interpolate(L.restricted, { n: r.count })}</div>}
          {mode === "listed" && r.items.length > 0 && (
            <ul className="ms-5 mt-1 grid gap-0.5 text-xs text-muted-foreground">
              {r.items.slice(0, 5).map((i) => (
                <li key={i.id} className="flex flex-wrap gap-x-2">
                  <bdi className="text-foreground">{i.label}</bdi>
                  {i.owner && <bdi>{i.owner}</bdi>}
                  {i.amount != null && <span className="tabular">{formatMoney(i.amount, fmt)}</span>}
                </li>
              ))}
              {r.items.length > 5 && <li>{interpolate(m.ops.andMore, { n: r.items.length - 5 })}</li>}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
