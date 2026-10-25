"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect } from "@/components/app/field";
import { ActionButton } from "@/components/app/action-button";
import { TimeAgo } from "@/components/app/time-ago";
import { GapMark } from "@/components/brand/gap-mark";
import { PanelHeader } from "@/components/operations/primitives";
import { useAction } from "@/hooks/use-action";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import type { handoverPreview } from "@/server/modules/org/service";
import type { HoldingKey } from "@/server/modules/org/handover";
import { departMemberAction, handoverPreviewAction } from "./actions";

type Preview = Awaited<ReturnType<typeof handoverPreview>>;
export interface Candidate { userId: string; name: string; roleName: string; canManageProjects: boolean }

const ASSIGNABLE: HoldingKey[] = ["H1", "H2", "H3", "H6", "H7", "H8", "H9", "H10", "H11", "H12", "H13"];
const INFO: HoldingKey[] = ["H4", "H5", "H14", "H15"];
const UNOWNED = "UNOWNED";

/** Whether a member holds anything a handover would move or report. */
export function holdsAnything(p: Preview) {
  return p.rows.some((r) => r.count > 0);
}

/**
 * The handover dialog (BUSINESS_RULES §2, UX note 2): what the person holds, one replacement or one
 * per group ("Leave unowned" per group, never for the last PM of a live project), then suspend or
 * revoke in one transaction. Holdings that changed meanwhile refresh the counts and keep the choices.
 */
export function HandoverDialog({ orgSlug, membershipId, roleName, status, candidates, initial, open, onOpenChange }: { orgSlug: string; membershipId: string; roleName: string; status: "SUSPENDED" | "REVOKED"; candidates: Candidate[]; initial: Preview; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { m } = useI18n();
  const H = m.org.handover;
  const [preview, setPreview] = useState<Preview>(initial);
  const [all, setAll] = useState<string>("");
  const [perGroup, setPerGroup] = useState(false);
  const [per, setPer] = useState<Partial<Record<HoldingKey, string>>>({});
  const [changed, setChanged] = useState(false);
  const load = useAction(handoverPreviewAction, { orgSlug, success: false, refresh: false });
  const depart = useAction(departMemberAction, {
    orgSlug,
    success: false,
    onSuccess: (r) => {
      const moved = Object.values(r?.moved ?? {}).reduce((n, x) => n + (x ?? 0), 0);
      const unowned = Object.values(r?.unowned ?? {}).reduce((n, x) => n + (x ?? 0), 0);
      toast.success(interpolate(H.done, { moved, unowned }));
      if (r?.shiftClashes.length) toast.warning(interpolate(H.clash, { n: r.shiftClashes.length }));
      onOpenChange(false);
    },
  });

  const count = (k: HoldingKey) => preview.rows.find((r) => r.key === k)?.count ?? 0;
  const targetOf = (k: HoldingKey) => (perGroup ? per[k] ?? all : all) || UNOWNED;
  const pmTarget = targetOf("H6");
  const pmOk = !preview.lastManagerOf.length || (pmTarget !== UNOWNED && !!candidates.find((c) => c.userId === pmTarget)?.canManageProjects);
  const unownedCount = ASSIGNABLE.filter((k) => targetOf(k) === UNOWNED).reduce((n, k) => n + count(k), 0);

  const submit = async () => {
    const perCategory = Object.fromEntries(ASSIGNABLE.filter((k) => count(k) > 0).map((k) => [k, targetOf(k)]));
    const expected = Object.fromEntries(preview.rows.map((r) => [r.key, r.count]));
    const r = await depart.run({ membershipId, status, handover: { replacementId: all && all !== UNOWNED ? all : null, perCategory, expected } });
    if (!r.ok && r.error === "errors.staleWrite") {
      // responsibilities changed since the dialog opened: refresh the counts, keep the selections
      const fresh = await load.run({ membershipId });
      if (fresh.ok) setPreview(fresh.data);
      setChanged(true);
    }
  };

  const options = (
    <>
      <option value="">{H.choose}</option>
      {candidates.map((c) => <option key={c.userId} value={c.userId}>{c.name} — {c.roleName}</option>)}
      <option value={UNOWNED}>{H.leaveUnowned}</option>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90dvh,48rem)] flex-col gap-0 p-0 sm:max-w-2xl max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none" data-testid="handover-dialog">
        <DialogHeader className="border-b px-5 pt-5 pb-3">
          <DialogTitle>{interpolate(H.title, { name: preview.member.name })}</DialogTitle>
          <DialogDescription>
            <span>{roleName} · </span>
            {preview.member.lastLoginAt ? <span>{H.lastSeen.split("{when}")[0]}<TimeAgo date={preview.member.lastLoginAt} /></span> : H.neverSeen}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-5 py-4">
          {changed && <Alert className="border-warning/40 bg-warning-soft text-warning" data-testid="handover-changed">{H.changed}</Alert>}
          {load.pending && <div className="grid gap-2" aria-busy="true" aria-label={H.loading}><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>}
          <p className="text-sm">{H.lead}</p>
          <section>
            <label className="grid gap-1.5">
              <span className="text-sm font-medium">{H.replacement}</span>
              <NativeSelect value={all} onChange={(e) => setAll(e.target.value)} aria-label={H.replacement} data-testid="handover-replacement">{options}</NativeSelect>
            </label>
            <div className="mt-2 grid gap-2">
              <button type="button" className="w-fit text-xs font-medium text-primary underline-offset-2 hover:underline" aria-expanded={perGroup} onClick={() => setPerGroup((x) => !x)} data-testid="handover-per-group">
                {perGroup ? H.perGroupHide : H.perGroup}
              </button>
              {unownedCount > 0 && (
                <p className="flex items-center gap-1.5 text-xs text-warning"><GapMark size={12} />{interpolate(H.unownedHint, { n: unownedCount })}</p>
              )}
            </div>
          </section>
          <section>
            <PanelHeader title={H.held} as="h3" />
            <ul className="divide-y">
              {ASSIGNABLE.filter((k) => count(k) > 0).map((k) => (
                <li key={k} className="grid gap-1.5 py-2.5 text-[13px] sm:grid-cols-[1fr_minmax(0,16rem)] sm:items-center" data-testid={`handover-row-${k}`}>
                  <div>
                    <span className="font-medium">{H.rows[k as keyof typeof H.rows]}</span> <span className="tabular text-muted-foreground">{count(k)}</span>
                    {k === "H3" && <p className="text-[11px] text-muted-foreground">{H.approvalsHint}</p>}
                    {k === "H6" && preview.lastManagerOf.length > 0 && (
                      <p className={pmOk ? "text-[11px] text-muted-foreground" : "flex items-center gap-1 text-[11px] text-warning"} data-testid="handover-last-manager">
                        {!pmOk && <GapMark size={11} />}
                        {interpolate(H.lastManager, { name: preview.member.name, code: preview.lastManagerOf.map((p) => p.code).join("، ") })}
                      </p>
                    )}
                  </div>
                  {perGroup && (
                    <NativeSelect value={per[k] ?? all} onChange={(e) => setPer((x) => ({ ...x, [k]: e.target.value }))} aria-label={H.rows[k as keyof typeof H.rows]} className="h-8">
                      {options}
                    </NativeSelect>
                  )}
                </li>
              ))}
              {INFO.filter((k) => count(k) > 0).map((k) => (
                <li key={k} className="py-2.5 text-[13px] text-muted-foreground" data-testid={`handover-row-${k}`}>
                  <span className="font-medium text-foreground">{H.rows[k as keyof typeof H.rows]}</span> <span className="tabular">{count(k)}</span>
                  <p className="text-[11px]">{k === "H14" ? H.deliveriesHint : H.info[k as keyof typeof H.info]}</p>
                </li>
              ))}
            </ul>
            {!holdsAnything(preview) && <p className="py-2 text-sm text-muted-foreground">{H.nothingHeld}</p>}
          </section>
        </div>
        <div className="flex shrink-0 flex-col-reverse gap-2 border-t bg-card px-5 py-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{m.common.cancel}</Button>
          <ActionButton variant={status === "REVOKED" ? "destructive" : "default"} disabled={!pmOk || depart.pending} action={submit} data-testid="handover-confirm">
            {status === "REVOKED" ? H.revoke : H.suspend}
          </ActionButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
