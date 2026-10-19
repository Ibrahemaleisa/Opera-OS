"use client";

import { Switch } from "@/components/ui/switch";
import { Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { TimeAgo } from "@/components/app/time-ago";
import { useAction } from "@/hooks/use-action";
import { useI18n } from "@/lib/i18n/client";
import type { listAutomation } from "@/server/modules/automation/admin";
import { setRuleEnabledAction } from "./actions";

type D = Awaited<ReturnType<typeof listAutomation>>;

export function AutomationRules({ orgSlug, data }: { orgSlug: string; data: D }) {
  const { m, locale } = useI18n();
  const t = m.org.automation;
  const toggle = useAction(setRuleEnabledAction, { orgSlug });
  return (
    <div className="grid gap-4">
      {data.backlog > 0 && <p className="text-xs text-muted-foreground">{t.backlog}: <span className="tabular">{data.backlog}</span></p>}
      <Section title={`${t.title} (${data.rules.length})`}>
        <ul className="divide-y">
          {data.rules.map((r) => (
            <li key={r.id} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_200px_200px_60px] md:items-center" data-testid="automation-rule">
              <div><div className="text-[13px] font-medium">{(locale === "en" && r.nameEn) || r.name}{r.isSystem && <span className="ms-2 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{t.system}</span>}</div></div>
              <span className="ltr-nums font-mono text-[11px] text-muted-foreground">{t.trigger}: {r.trigger}</span>
              <span className="tabular text-[11px]"><span className="text-success">{t.succeeded} {r.stats.succeeded}</span> · <span className={r.stats.failed ? "text-danger" : "text-muted-foreground"}>{t.failed} {r.stats.failed}</span> · <span className="text-muted-foreground">{t.skipped} {r.stats.skipped}</span></span>
              <Switch checked={r.enabled} disabled={toggle.pending} onCheckedChange={(v) => toggle.run({ id: r.id, enabled: v })} aria-label={t.enabled} />
            </li>
          ))}
        </ul>
      </Section>
      <Section title={t.recent}>
        {data.recent.length === 0 ? <p className="px-4 py-6 text-center text-xs text-muted-foreground">{m.common.none}</p> : (
          <ul className="divide-y">
            {data.recent.map((e) => (
              <li key={e.id} className="grid gap-1 px-4 py-2 text-xs md:grid-cols-[1fr_120px_160px] md:items-center">
                <span>{e.rule}{e.error && <span className="ms-2 text-danger">{e.error}</span>}</span>
                <StatusBadge status={e.status === "SUCCEEDED" ? "DONE" : e.status} label={m.enums.executionStatus[e.status]} />
                <span className="text-muted-foreground"><TimeAgo date={e.createdAt} />{e.attempts > 1 ? ` · ×${e.attempts}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
