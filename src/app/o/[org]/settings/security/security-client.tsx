"use client";

import { ShieldCheck } from "lucide-react";
import { Section } from "@/components/app/page";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/app/status-badge";
import { ConfirmAction } from "@/components/app/confirm-action";
import { GapMark } from "@/components/brand/gap-mark";
import { useAction } from "@/hooks/use-action";
import { useI18n } from "@/lib/i18n/client";
import { interpolate } from "@/lib/i18n/define";
import { adminResetMfaAction, sendResetLinkAction, setMfaPolicyAction } from "./actions";

interface Member {
  membershipId: string;
  userId: string;
  name: string;
  role: string;
  baseRole: string;
  enrolled: boolean;
  gate: { state: "none" | "enforced" } | { state: "grace"; daysLeft: number };
  self: boolean;
}

interface Data {
  policy: { mfaRequired: boolean };
  members: Member[];
  notEnrolled: number;
  canEdit: boolean;
}

/** Settings → Security: one switch, and who has set it up. The grace period works quietly. */
export function SecurityClient({ orgSlug, data, canManageMembers, isOwner }: { orgSlug: string; data: Data; canManageMembers: boolean; isOwner: boolean }) {
  const { m } = useI18n();
  const t = m.auth.security;
  const policy = useAction(setMfaPolicyAction, { orgSlug, success: t.saved });
  const reset = useAction(adminResetMfaAction, { orgSlug });
  const link = useAction(sendResetLinkAction, { orgSlug, success: t.resetSent });
  return (
    <Section>
      <div className="grid gap-3 p-4 text-sm">
        <label className="flex items-start gap-3">
          <Switch checked={data.policy.mfaRequired} disabled={!data.canEdit || policy.pending} onCheckedChange={(v) => policy.run({ mfaRequired: v })} data-testid="mfa-required" />
          <span>
            <span className="block font-medium">{t.requireLabel}</span>
            <span className="text-xs text-muted-foreground">{t.requireHint}</span>
          </span>
        </label>
        {!data.canEdit && <p className="text-xs text-muted-foreground">{t.ownerOnly}</p>}
        {data.policy.mfaRequired && (
          data.notEnrolled ? (
            <p className="flex items-center gap-2 text-warning"><GapMark /> {interpolate(t.notEnrolled, { n: data.notEnrolled })}</p>
          ) : (
            <p className="flex items-center gap-2 text-success"><ShieldCheck className="size-4" /> {t.allEnrolled}</p>
          )
        )}
      </div>
      {data.members.length > 0 && (
        <ul className="divide-y border-t text-sm">
          {data.members.map((x) => {
            const status = x.enrolled ? (
              <StatusBadge tone="success" label={t.enrolled} />
            ) : x.gate.state === "enforced" ? (
              <StatusBadge tone="danger" label={t.overdue} />
            ) : x.gate.state === "grace" ? (
              <StatusBadge tone="warning" label={interpolate(t.pending, { n: x.gate.daysLeft })} />
            ) : (
              <StatusBadge tone="muted" label={t.notRequired} />
            );
            const mayAct = canManageMembers && !x.self && (isOwner || x.baseRole !== "OWNER");
            return (
              <li key={x.membershipId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5" data-testid="security-member">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{x.name}</span>
                  <span className="text-xs text-muted-foreground">{x.role}</span>
                </span>
                {status}
                {mayAct && (
                  <span className="flex gap-1">
                    <ConfirmAction
                      trigger={<Button size="xs" variant="ghost">{t.sendReset}</Button>}
                      title={interpolate(t.sendResetTitle, { name: x.name })}
                      description={t.sendResetBody}
                      confirmLabel={t.sendReset}
                      onConfirm={() => link.run({ membershipId: x.membershipId })}
                    />
                    {x.enrolled && (
                      <ConfirmAction
                        trigger={<Button size="xs" variant="ghost" className="text-danger">{t.resetMfa}</Button>}
                        title={interpolate(t.resetTitle, { name: x.name })}
                        description={t.resetBody}
                        confirmLabel={t.resetMfa}
                        destructive
                        field={{ type: "textarea", label: t.reason, required: true, hint: m.errors.reasonRequired }}
                        onConfirm={(reason) => reset.run({ membershipId: x.membershipId, reason })}
                      />
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
