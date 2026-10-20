import Link from "next/link";
import { CheckCircle2, Clock4, FileSpreadsheet, Package, Repeat, Target, Truck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ProgressBar, Section, Stat } from "@/components/app/page";
import { BarList } from "@/components/app/charts";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";
import { getI18n } from "@/lib/i18n/server";
import { can } from "@/server/authz/policy";
import { campaignKpis, listCampaigns } from "@/server/modules/delivery/analytics";
import { requirePageContext } from "@/server/request";
import { CampaignSwitcher, NewCampaignButton } from "./campaign-controls";
import { guardPage } from "@/server/page-guard";

async function DeliveryOverview({ params, searchParams }: { params: Promise<{ org: string; projectId: string }>; searchParams: Promise<{ c?: string }> }) {
  const { org, projectId } = await params;
  const { c } = await searchParams;
  const ctx = await requirePageContext(org);
  const { m, fmt } = await getI18n();
  const campaigns = await listCampaigns(ctx, projectId);
  const b = `/o/${org}/projects/${projectId}/delivery`;
  const canDispatch = can(ctx, "delivery.dispatch");
  if (!campaigns.length) return <Section><EmptyState icon={<Package />} title={m.delivery.noCampaign} action={canDispatch && <NewCampaignButton orgSlug={org} projectId={projectId} />} /></Section>;
  const current = campaigns.find((x) => x.id === c) ?? campaigns[0];
  const k = await campaignKpis(ctx, current.id);
  const d = m.delivery;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <CampaignSwitcher campaigns={campaigns.map((x) => ({ id: x.id, name: x.name }))} current={current.id} />
        {k.campaign.deadline && <span className="text-xs text-muted-foreground">{d.deadline}: <span className="tabular">{formatDate(k.campaign.deadline, fmt)}</span></span>}
        <div className="ms-auto flex flex-wrap gap-2">
          {canDispatch && <NewCampaignButton orgSlug={org} projectId={projectId} />}
          {can(ctx, "recipient.import") && <Button asChild size="sm" variant="outline"><Link href={`${b}/imports?c=${current.id}`}><FileSpreadsheet /> {d.import.upload}</Link></Button>}
          {can(ctx, "export.data") && <Button asChild size="sm" variant="outline"><a href={`/api/o/${org}/exports/deliveries?projectId=${projectId}&campaignId=${current.id}&format=xlsx`}>{d.exportReport} (XLSX)</a></Button>}
          {can(ctx, "export.data") && <Button asChild size="sm" variant="ghost"><a href={`/api/o/${org}/exports/deliveries?projectId=${projectId}&campaignId=${current.id}&format=csv`}>CSV</a></Button>}
          {canDispatch && <Button asChild size="sm"><Link href={`/o/${org}/dispatch?project=${projectId}&campaign=${current.id}`}><Truck /> {d.dispatch.title}</Link></Button>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label={m.common.total} value={formatNumber(k.total, fmt)} icon={<Package />} href={`${b}/cards?c=${current.id}`} />
        <Stat label={d.delivered} value={formatNumber(k.delivered, fmt)} tone="success" icon={<CheckCircle2 />} href={`${b}/cards?c=${current.id}&status=DELIVERED`} />
        <Stat label={d.unassigned} value={formatNumber(k.pending, fmt)} icon={<Clock4 />} href={`${b}/cards?c=${current.id}&status=READY`} />
        <Stat label={d.inField} value={formatNumber(k.inProgress, fmt)} icon={<Truck />} />
        <Stat label={d.failed} value={formatNumber(k.failed, fmt)} tone={k.failed ? "danger" : "default"} icon={<XCircle />} href={`${b}/cards?c=${current.id}&status=FAILED_ATTEMPT`} />
        <Stat label={m.enums.deliveryStatus.RESCHEDULED} value={formatNumber(k.rescheduled, fmt)} icon={<Repeat />} />
        <Stat label={d.firstAttempt} value={formatPercent(k.firstAttemptSuccess, fmt)} icon={<Target />} hint={`${d.avgAttempts}: ${k.avgAttempts?.toFixed(2) ?? "—"}`} />
        <Stat label={d.sla} value={formatPercent(k.slaCompliance, fmt)} icon={<Clock4 />} />
      </div>
      <Section>
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="text-sm font-medium">{d.completion}</span>
          <ProgressBar value={(k.completion ?? 0) * 100} tone="success" className="h-2.5 flex-1" />
          <span className="tabular text-sm font-semibold">{formatPercent(k.completion, fmt)}</span>
        </div>
      </Section>
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title={d.agentPerformance}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-muted/60 text-xs text-muted-foreground"><tr className="border-b">{[d.agent, d.registry.deliveries, d.delivered, d.failed, "%"].map((h) => <th key={h} className="h-8 px-3 text-start font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {k.agents.map((a) => (
                  <tr key={a.id} className="border-b last:border-0">
                    <td className="px-3 py-2">{a.name}</td><td className="tabular px-3">{a.assigned}</td><td className="tabular px-3 text-success">{a.delivered}</td><td className="tabular px-3 text-danger">{a.failed}</td><td className="tabular px-3">{formatPercent(a.successRate, fmt)}</td>
                  </tr>
                ))}
                {!k.agents.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground">{m.common.none}</td></tr>}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title={d.geography}>
          <div className="p-4">{k.geography.length ? <BarList items={k.geography.slice(0, 10).map((g) => ({ key: g.city + g.district, label: `${g.city} · ${g.district}`, value: g.total }))} /> : <p className="text-xs text-muted-foreground">{m.common.none}</p>}</div>
        </Section>
        <Section title={d.failureReasons}>
          <div className="p-4">{k.failureReasons.length ? <BarList items={k.failureReasons.map((r) => ({ key: r.reason, label: (d.reasons as Record<string, string>)[r.reason] ?? r.reason, value: r.count, tone: "var(--danger)" }))} /> : <p className="text-xs text-muted-foreground">{m.common.none}</p>}</div>
        </Section>
      </div>
      <Section title={m.common.status}>
        <div className="p-4"><BarList items={k.byStatus.map((s) => ({ key: s.status, label: m.enums.deliveryStatus[s.status], value: s.count }))} /></div>
      </Section>
    </div>
  );
}

export default guardPage(DeliveryOverview);
