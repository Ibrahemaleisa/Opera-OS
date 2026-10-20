import Link from "next/link";
import { AlertTriangle, CalendarClock, CheckCheck, ClipboardCheck, FolderKanban, Package, Send, ShieldAlert } from "lucide-react";
import { EmptyState, PageBody, PageHeader, ProgressBar, Section, Stat } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { formatDateTime, formatMoney, formatPercent } from "@/lib/format";
import { getI18n } from "@/lib/i18n/server";
import { orgDashboard } from "@/server/modules/analytics/service";
import { requirePageContext } from "@/server/request";
import { BarList } from "@/components/app/charts";
import { guardPage } from "@/server/page-guard";

async function DashboardPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m, fmt } = await getI18n();
  const d = await orgDashboard(ctx);
  const b = `/o/${org}`;
  const dsh = m.dashboard;
  return (
    <PageBody>
      <PageHeader title={dsh.title} description={ctx.orgName} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label={dsh.activeProjects} value={d.projects.active} icon={<FolderKanban />} href={`${b}/projects`} hint={d.projects.atRisk ? `${d.projects.atRisk} ${m.enums.projectStatus.AT_RISK}` : undefined} />
        <Stat label={dsh.overdueTasks} value={d.tasks.overdue} tone={d.tasks.overdue ? "danger" : "default"} icon={<AlertTriangle />} hint={`${d.tasks.open} ${dsh.open}`} />
        <Stat label={dsh.onTime} value={formatPercent(d.tasks.onTimeRate, fmt)} icon={<CheckCheck />} hint={dsh.last90} />
        <Stat label={dsh.pendingApprovals} value={d.approvals.pending} icon={<ClipboardCheck />} hint={`${d.approvals.clientPending} ${dsh.client}`} href={`${b}/my-work`} />
        <Stat label={dsh.deliveryProgress} value={formatPercent(d.delivery.completion, fmt)} icon={<Package />} hint={`${d.delivery.delivered}/${d.delivery.total}`} href={`${b}/delivery`} />
        <Stat label={dsh.rsvpRate} value={formatPercent(d.invitations.rsvpRate, fmt)} icon={<Send />} hint={`${d.invitations.attending} ${m.enums.rsvp.ATTENDING}`} />
        <Stat label={dsh.risks} value={d.risks.high} tone={d.risks.high ? "warning" : "default"} icon={<ShieldAlert />} hint={`${d.tasks.escalations} ${dsh.escalations}`} />
        <Stat label={dsh.incidents} value={d.incidents.open} tone={d.incidents.open ? "danger" : "default"} icon={<AlertTriangle />} href={`${b}/events`} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Section title={dsh.portfolio}>
          {d.projects.byStatus.length ? (
            <div className="p-4"><BarList items={d.projects.byStatus.map((s) => ({ key: s.status, label: m.enums.projectStatus[s.status as keyof typeof m.enums.projectStatus], value: s.count }))} /></div>
          ) : <EmptyState title={m.projects.noProjects} />}
        </Section>
        <Section title={dsh.workload}>
          {d.workload.length ? <div className="p-4"><BarList items={d.workload.map((w) => ({ key: w.userId, label: w.name, value: w.open }))} /></div> : <EmptyState title={m.common.emptyTitle} />}
        </Section>
        <Section title={dsh.upcomingEvents}>
          <ul className="divide-y">
            {d.upcomingEvents.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                <CalendarClock className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1"><Link href={`${b}/projects/${e.projectId}/events/${e.id}`} className="block truncate text-[13px] font-medium hover:text-primary">{e.name}</Link><span className="tabular text-xs text-muted-foreground">{formatDateTime(e.startsAt, fmt)}</span></div>
                <StatusBadge status={e.phase} label={m.enums.eventPhase[e.phase]} />
              </li>
            ))}
            {d.upcomingEvents.length === 0 && <li className="px-4 py-6 text-center text-xs text-muted-foreground">{m.common.none}</li>}
          </ul>
        </Section>
        <Section title={dsh.deliveryStatus}>
          {d.delivery.total ? <div className="p-4"><BarList items={d.delivery.byStatus.map((s) => ({ key: s.status, label: m.enums.deliveryStatus[s.status], value: s.count }))} /></div> : <EmptyState title={m.common.emptyTitle} />}
        </Section>
        <Section title={dsh.production}>
          {d.booths.length ? <div className="p-4"><BarList items={d.booths.map((s) => ({ key: s.stage, label: m.enums.boothStage[s.stage], value: s.count }))} /></div> : <EmptyState title={m.common.emptyTitle} />}
        </Section>
        {d.finance && (
          <Section title={dsh.budget} description={m.projects.forecastNote}>
            <div className="grid gap-3 p-4 text-sm">
              {([["planned", d.finance.planned], ["committed", d.finance.committed], ["actual", d.finance.actual]] as const).map(([k, v]) => (
                <div key={k}>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">{m.projects[k]}</span><span className="tabular">{formatMoney(v, fmt)}</span></div>
                  <ProgressBar value={d.finance!.planned ? (v / d.finance!.planned) * 100 : 0} tone={k === "actual" && v > d.finance!.planned ? "danger" : "jade"} className="mt-1" />
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </PageBody>
  );
}

export default guardPage(DashboardPage);
