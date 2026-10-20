import Link from "next/link";
import { EmptyState, PageBody, PageHeader, Section, Stat } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { formatMoney, formatPercent } from "@/lib/format";
import { getI18n } from "@/lib/i18n/server";
import { financeOverview } from "@/server/modules/finance/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

async function FinanceOverviewPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m, fmt } = await getI18n();
  const t = m.finance;
  const data = await financeOverview(ctx);
  const money = (v: number | null | undefined) => formatMoney(v ?? null, { ...fmt, compact: true });
  const sum = (f: (p: (typeof data.projects)[number]) => number | null | undefined) => data.projects.reduce((a, p) => a + (f(p) ?? 0), 0);
  const contract = sum((p) => p.contract.revised);
  const forecast = sum((p) => p.totals.forecast);
  return (
    <PageBody>
      <PageHeader title={t.title} description={t.overviewDesc} />
      {data.projects.length === 0 ? <EmptyState title={t.noFinance} /> : (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label={t.revisedContract} value={money(contract)} />
            <Stat label={t.planned} value={money(sum((p) => p.totals.planned))} />
            <Stat label={t.committed} value={money(sum((p) => p.totals.committed))} />
            <Stat label={t.actual} value={money(sum((p) => p.totals.actual))} />
            <Stat label={t.margin} value={money(contract - forecast)} hint={contract ? formatPercent((contract - forecast) / contract, fmt) : undefined} tone={contract - forecast < 0 ? "danger" : "success"} />
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <Section title={m.projects.title}>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead className="border-b bg-muted/40 text-[11px] text-muted-foreground"><tr>{[m.projects.title, t.revisedContract, t.planned, t.committed, t.actual, t.forecast, t.margin].map((h) => <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>)}</tr></thead>
                  <tbody className="divide-y">
                    {data.projects.map((p) => (
                      <tr key={p.id} className="hover:bg-muted/40">
                        <td className="px-3 py-2"><Link className="font-medium hover:underline" href={`/o/${org}/projects/${p.id}/finance`}>{p.name}</Link><div className="ltr-nums text-[11px] text-muted-foreground">{p.code}</div></td>
                        <td className="tabular px-3 py-2">{money(p.contract.revised)}</td>
                        <td className="tabular px-3 py-2">{money(p.totals.planned)}</td>
                        <td className="tabular px-3 py-2">{money(p.totals.committed)}</td>
                        <td className="tabular px-3 py-2">{money(p.totals.actual)}</td>
                        <td className={`tabular px-3 py-2 ${p.totals.planned > 0 && p.totals.forecast > p.totals.planned ? "text-danger" : ""}`}>{money(p.totals.forecast)}</td>
                        <td className={`tabular px-3 py-2 ${p.margin && p.margin.amount < 0 ? "text-danger" : ""}`}>{p.margin ? `${money(p.margin.amount)} · ${formatPercent(p.margin.ratio, fmt)}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
            <Section title={`${t.pendingApprovals} (${data.pendingApprovals.length})`}>
              {data.pendingApprovals.length === 0 ? <p className="px-4 py-6 text-center text-xs text-muted-foreground">{m.common.none}</p> : (
                <ul className="divide-y">
                  {data.pendingApprovals.map((a) => (
                    <li key={a.id}><Link href={`/o/${org}/projects/${a.projectId}/approvals`} className="grid gap-1 px-4 py-2.5 hover:bg-muted/40"><span className="text-[13px] font-medium">{a.title}</span><StatusBadge status="PENDING_APPROVAL" label={t.entity[a.entityType as keyof typeof t.entity] ?? a.entityType} /></Link></li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </div>
      )}
    </PageBody>
  );
}

export default guardPage(FinanceOverviewPage);
