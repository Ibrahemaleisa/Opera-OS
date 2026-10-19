import Link from "next/link";
import { Package } from "lucide-react";
import { EmptyState, PageBody, PageHeader, ProgressBar, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { formatDate, formatPercent } from "@/lib/format";
import { getI18n } from "@/lib/i18n/server";
import { orgDeliveryOverview } from "@/server/modules/delivery/analytics";
import { requirePageContext } from "@/server/request";

export default async function OrgDeliveryPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m, fmt } = await getI18n();
  const campaigns = await orgDeliveryOverview(ctx);
  const d = m.delivery;
  return (
    <PageBody>
      <PageHeader title={d.title} description={d.overviewDesc} />
      {campaigns.length === 0 ? <Section><EmptyState icon={<Package />} title={d.noCampaign} /></Section> : (
        <Section>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr className="border-b">{[d.campaign, m.nav.projects, m.common.status, d.completion, d.delivered, d.inField, d.unassigned, d.failed, d.deadline].map((h) => <th key={h} className="h-8 px-3 text-start font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="px-3 py-2.5"><Link className="font-medium hover:text-primary" href={`/o/${org}/projects/${c.project.id}/delivery?c=${c.id}`}>{c.name}</Link></td>
                    <td className="ltr-nums px-3 text-xs text-muted-foreground">{c.project.code}</td>
                    <td className="px-3"><StatusBadge status={c.status} label={m.enums.campaignStatus[c.status]} /></td>
                    <td className="w-40 px-3"><ProgressBar value={c.total ? (c.delivered / c.total) * 100 : 0} tone="success" /><span className="tabular text-[11px] text-muted-foreground">{formatPercent(c.total ? c.delivered / c.total : null, fmt)}</span></td>
                    <td className="tabular px-3 text-success">{c.delivered}</td>
                    <td className="tabular px-3">{c.inField}</td>
                    <td className="tabular px-3"><Link className="hover:text-primary" href={`/o/${org}/dispatch?project=${c.project.id}&campaign=${c.id}`}>{c.unassigned}</Link></td>
                    <td className="tabular px-3 text-danger">{c.failed}</td>
                    <td className="tabular px-3 text-xs">{formatDate(c.deadline, fmt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </PageBody>
  );
}
