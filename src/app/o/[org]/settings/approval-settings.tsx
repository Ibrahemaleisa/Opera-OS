"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Field, NativeSelect } from "@/components/app/field";
import { Section } from "@/components/app/page";
import { NumberInput } from "@/components/app/number-input";
import { useAction } from "@/hooks/use-action";
import { formatDate, formatMoney, parseRiyadhDate, toDateInput } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import type { getApprovalSettingsView } from "@/server/modules/approvals/settings";
import { setApprovalExceptionAction, setApprovalPolicyAction, setApprovalSlaAction } from "./approval-actions";

type View = Awaited<ReturnType<typeof getApprovalSettingsView>>;
const TYPES = ["PURCHASE_ORDER", "EXPENSE", "CHANGE_ORDER", "CAMPAIGN", "TASK", "DELIVERABLE", "MILESTONE", "DESIGN_REVISION"] as const;

/**
 * Settings → Approvals (BUSINESS_RULES §4.3): one plain toggle for owners — self-approval when no one
 * else can approve. Who-approves policy, time to decide, scope, caps and an optional end date sit
 * behind "Advanced", with defaults that need no attention.
 */
export function ApprovalSettings({ orgSlug, view }: { orgSlug: string; view: View }) {
  const { m, fmt } = useI18n();
  const A = m.org.approvals;
  const policy = useAction(setApprovalPolicyAction, { orgSlug });
  const sla = useAction(setApprovalSlaAction, { orgSlug });
  const exception = useAction(setApprovalExceptionAction, { orgSlug });
  const ex = view.exception;
  const on = view.exceptionActive;
  const [hours, setHours] = useState(String(view.slaHours));
  const [types, setTypes] = useState<string[]>(ex?.types ?? [...TYPES]);
  const [spendCap, setSpendCap] = useState(String(ex?.spendCap ?? view.limits.defaultSpendCap));
  const [audienceCap, setAudienceCap] = useState(String(ex?.audienceCap ?? view.limits.defaultAudienceCap));
  const [ends, setEnds] = useState(ex?.expiresAt ? toDateInput(ex.expiresAt) : "");
  const typeLabel = (t: string) => (A.type as Record<string, string>)[t] ?? t;
  const owner = view.isOwner;

  return (
    <Section title={A.title} description={owner ? undefined : A.ownerOnly}>
      <div className="grid gap-4 p-4" data-testid="approval-settings">
        <div className="flex items-start justify-between gap-4">
          <label htmlFor="self-approval" className="grid gap-0.5">
            <span className="text-sm font-medium">{A.selfApproval}</span>
            <span className="text-xs text-muted-foreground">{A.selfApprovalHint}</span>
            {on && ex && (
              <span className="text-xs text-muted-foreground" data-testid="approval-exception-on">
                {interpolate(A.on, { date: formatDate(ex.enabledAt, fmt), name: ex.enabledByName ?? "—" })}
                {ex.expiresAt && <> · {interpolate(A.until, { date: formatDate(ex.expiresAt, fmt) })}</>}
              </span>
            )}
            {!on && ex?.enabled && ex.expiresAt && <span className="text-xs text-warning">{interpolate(A.expired, { date: formatDate(ex.expiresAt, fmt) })}</span>}
          </label>
          <Switch
            id="self-approval"
            checked={on}
            disabled={!owner || exception.pending}
            onCheckedChange={(v) => exception.run(v ? { action: "enable" } : { action: "disable" })}
            data-testid="approval-exception-toggle"
          />
        </div>
        {view.month.count > 0 && <p className="tabular text-xs text-muted-foreground">{interpolate(A.month, { count: view.month.count, amount: formatMoney(view.month.amount, fmt) })}</p>}

        <details className="group border-t pt-3" data-testid="approval-advanced">
          <summary className="cursor-pointer list-none text-xs font-medium text-primary hover:underline">{A.advanced}</summary>
          <div className="mt-3 grid gap-4">
            <Field label={A.policy}>
              <NativeSelect value={view.policy} disabled={!owner || policy.pending} onChange={(e) => policy.run({ policy: e.target.value as "STANDARD" | "STRICT" })} data-testid="approval-policy">
                <option value="STANDARD">{A.policyStandard}</option>
                <option value="STRICT">{A.policyStrict}</option>
              </NativeSelect>
            </Field>
            <Field label={A.sla} hint={A.slaHint} error={sla.errorFor("hours")}>
              <div className="flex gap-2">
                <NumberInput value={hours} decimal={false} onChange={(e) => setHours(e.target.value)} className="max-w-28" data-testid="approval-sla" />
                <Button type="button" variant="outline" size="sm" disabled={sla.pending || Number(hours) === view.slaHours} onClick={() => sla.run({ hours: Number(hours) })}>{A.saveSla}</Button>
              </div>
            </Field>
            {on && owner && (
              <div className="grid gap-3" data-testid="approval-exception-options">
                <fieldset className="grid gap-1.5">
                  <legend className="mb-1 text-xs font-medium">{A.types}</legend>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {TYPES.map((t) => (
                      <label key={t} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="size-4" checked={types.includes(t)} onChange={(e) => setTypes((x) => (e.target.checked ? [...x, t] : x.filter((y) => y !== t)))} />
                        {typeLabel(t)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={A.spendCap} error={exception.errorFor("spendCap")}><NumberInput value={spendCap} onChange={(e) => setSpendCap(e.target.value)} /></Field>
                  <Field label={A.audienceCap} error={exception.errorFor("audienceCap")}><NumberInput value={audienceCap} decimal={false} onChange={(e) => setAudienceCap(e.target.value)} /></Field>
                  <Field label={A.expiresAt} error={exception.errorFor("expiresAt")}><Input type="date" value={ends} onChange={(e) => setEnds(e.target.value)} dir="ltr" /></Field>
                </div>
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={exception.pending || !types.length}
                    onClick={() => exception.run({ action: "update", types: types as (typeof TYPES)[number][], spendCap: Number(spendCap), audienceCap: Number(audienceCap), expiresAt: ends ? parseRiyadhDate(ends) : null })}
                  >
                    {A.saveOptions}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </details>
      </div>
    </Section>
  );
}
