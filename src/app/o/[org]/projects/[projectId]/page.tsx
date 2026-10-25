import Link from "next/link";
import { KV, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { StatusRing } from "@/components/brand/status-ring";
import { GapMark } from "@/components/brand/gap-mark";
import { HealthWord, ReasonList } from "@/components/operations/health";
import { relativeDay } from "@/components/operations/primitives";
import { describeAudit } from "@/components/operations/describe-audit";
import { formatDate, formatDual, formatMoney, formatPercent, formatRelative } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { getProjectOverview } from "@/server/modules/projects/service";
import { requirePageContext } from "@/server/request";
import { listClients } from "@/server/modules/org/service";
import { DeliverablesPanel, EditProjectButton, IndependentApprovalControl, MilestonesPanel, ProjectStatusMenu, RisksPanel } from "./overview-panels";
import { guardPage } from "@/server/page-guard";

async function ProjectOverviewPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const { m, fmt, locale } = await getI18n();
  const o = await getProjectOverview(ctx, projectId);
  // health v2 comes with the overview: the same computation as the portfolio and the operations board
  const { health } = o;
  const financeVisible = o.scope.finance;
  const now = new Date();
  const clients = o.scope.manage ? (await listClients(ctx)).map((c) => ({ id: c.id, name: c.name })) : [];
  const b = `/o/${org}/projects/${projectId}`;
  const p = o.project;
  const anchor = p.eventStartAt ?? p.deadline;
  const plain = JSON.parse(JSON.stringify(o)) as typeof o;
  const archived = p.status === "CLOSED" || p.status === "CANCELLED";
  const statusLabels = m.enums.projectStatus as Record<string, string>;
  return (
    <div className="grid gap-5">
      {(archived || p.status === "ON_HOLD") && (
        <div role="status" className="rounded-lg border bg-muted/40 px-4 py-2.5 text-sm" data-testid="project-archived-banner">
          {archived ? interpolate(m.projects.lifecycle.archived, { status: statusLabels[p.status] }) : statusLabels[p.status]}
          {p.statusReason && !o.scope.clientView && <span className="ms-2 text-muted-foreground"><bdi>{p.statusReason}</bdi></span>}
        </div>
      )}
      <section aria-labelledby="project-health" className="surface grid gap-x-8 gap-y-3 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-2">
          <h2 id="project-health" className="eyebrow">{m.ops.health.title}</h2>
          <div className="flex items-center gap-3">
            <StatusRing state={health.progress.total > 0 && health.progress.done >= health.progress.total ? "complete" : health.level === "critical" ? "late" : health.level === "watch" ? "awaiting" : health.progress.done > 0 ? "inProgress" : "notStarted"} value={health.progress.total ? health.progress.done / health.progress.total : 0} size={32} />
            <div>
              <HealthWord health={health} m={m} className="text-base" />
              <div className="tabular mt-0.5 text-xs text-muted-foreground">{interpolate(m.projects.tasksDone, { done: health.progress.done, total: health.progress.total })}</div>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {anchor ? (
              <span className="font-medium text-foreground">{interpolate(p.eventStartAt ? m.ops.health.anchorEvent : m.ops.health.anchorDeadline, { when: relativeDay(anchor, now, fmt.locale) })}</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-warning"><GapMark size={12} />{m.ops.health.noAnchor}</span>
            )}
            {health.schedule.expected !== null && <div className="tabular mt-0.5">{interpolate(m.ops.health.expected, { expected: formatPercent(health.schedule.expected, fmt), actual: formatPercent(health.schedule.actual, fmt) })}</div>}
          </div>
        </div>
        <ReasonList health={health} m={m} financeVisible={financeVisible} projectHref={b} className="md:border-s md:ps-6" />
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-5">
          <Section title={m.projects.workstreams} actions={<Link href={`${b}/workstreams`} className="text-xs text-primary">{m.common.view}</Link>}>
            <ul className="divide-y">
              {o.workstreams.map((w) => (
                <li key={w.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: w.color ?? "var(--muted-foreground)" }} />
                  <div className="min-w-0 flex-1">
                    <Link href={`${b}/tasks?ws=${w.id}`} className="text-[13px] font-medium hover:text-primary">{(locale === "en" && w.nameEn) || w.name}</Link>
                    <div className="text-[11px] text-muted-foreground">{m.enums.workstreamKind[w.kind]}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="tabular text-[11px] text-muted-foreground">{w.done}/{w.total}</span>
                    <StatusRing state={w.total > 0 && w.done >= w.total ? "complete" : w.blocked ? "paused" : w.done > 0 ? "inProgress" : "notStarted"} value={w.total ? w.done / w.total : 0} size={22} />
                  </div>
                </li>
              ))}
            </ul>
          </Section>
          <MilestonesPanel orgSlug={org} projectId={projectId} milestones={plain.milestones} canEdit={o.scope.operate} />
          <DeliverablesPanel orgSlug={org} projectId={projectId} deliverables={plain.deliverables} canEdit={o.scope.operate} />
          {!o.scope.clientView && <RisksPanel orgSlug={org} projectId={projectId} risks={plain.risks} canEdit={o.scope.operate} members={o.members.map((x) => ({ id: x.userId, name: x.user.nameAr ?? x.user.name }))} />}
        </div>

        <div className="grid content-start gap-5">
          <Section title={m.common.details} actions={(o.scope.manage || !!o.lifecycle?.targets.length) && <div className="flex items-center">{o.scope.manage && <EditProjectButton orgSlug={org} canFinance={o.scope.finance} clients={clients} project={{ id: p.id, version: p.version, name: p.name, nameEn: p.nameEn, description: p.description, clientId: p.clientId, type: p.type, priority: p.priority, contractRef: p.contractRef, poReference: p.poReference, budgetAmount: p.budgetAmount?.toString() ?? null, currency: p.currency, startDate: p.startDate, deadline: p.deadline, eventStartAt: p.eventStartAt, eventEndAt: p.eventEndAt, clientPortal: p.clientPortal, venueIds: p.venues.map((v) => v.venueId) }} />}<ProjectStatusMenu orgSlug={org} projectId={projectId} code={p.code} status={p.status} version={p.version} targets={o.lifecycle?.targets ?? []} /></div>}>
            <dl className="px-4 py-2">
              <KV label={m.projects.code}><span className="ltr-nums font-mono text-xs">{p.code}</span></KV>
              <KV label={m.projects.client}>{p.client?.name ?? "—"}</KV>
              <KV label={m.common.priority}><StatusBadge status={p.priority} label={m.enums.priority[p.priority]} /></KV>
              <KV label={m.projects.eventStart}>{p.eventStartAt ? formatDual(p.eventStartAt, fmt) : "—"}</KV>
              <KV label={m.common.startDate}>{formatDate(p.startDate, fmt)}</KV>
              <KV label={m.projects.deadline}>{formatDate(p.deadline, fmt)}</KV>
              <KV label={m.projects.venues}>{p.venues.map((v) => v.venue.name).join("، ") || "—"}</KV>
              <KV label={m.projects.contractRef}>{p.contractRef ?? "—"}</KV>
              {/* a quiet, advanced project setting: shown to those who may change it, or when it's on */}
              {!o.scope.clientView && (p.independentApprovalRequired || !!o.lifecycle?.canSetIndependent) && <KV label={m.projects.lifecycle.independent.label}><IndependentApprovalControl orgSlug={org} projectId={projectId} value={p.independentApprovalRequired} version={p.version} canSet={!!o.lifecycle?.canSetIndependent} /></KV>}
              <KV label={m.projects.templates}>{o.instances.map((i) => `${i.templateKey} v${i.versionNumber}`).join(", ") || "—"}</KV>
            </dl>
          </Section>
          {o.finance && (
            <Section title={m.projects.finance} description={m.projects.forecastNote}>
              <dl className="px-4 py-2">
                <KV label={m.projects.planned}><span className="tabular">{formatMoney(o.finance.planned, fmt)}</span></KV>
                <KV label={m.projects.committed}><span className="tabular">{formatMoney(o.finance.committed, fmt)}</span></KV>
                <KV label={m.projects.actual}><span className={`tabular ${o.finance.actual > o.finance.planned && o.finance.planned > 0 ? "text-danger" : ""}`}>{formatMoney(o.finance.actual, fmt)}</span></KV>
              </dl>
            </Section>
          )}
          {(o.campaigns.length > 0 || o.events.length > 0 || o.booths.length > 0) && (
            <Section title={m.projects.operations}>
              <ul className="divide-y text-[13px]">
                {o.campaigns.map((c) => (
                  <li key={c.id} className="flex items-center justify-between px-4 py-2"><Link className="hover:text-primary" href={`${b}/${c.type === "PHYSICAL" ? "delivery" : "digital"}`}>{c.name}</Link><StatusBadge status={c.status} label={m.enums.campaignStatus[c.status]} /></li>
                ))}
                {o.events.map((e) => (
                  <li key={e.id} className="flex items-center justify-between px-4 py-2"><Link className="hover:text-primary" href={`${b}/events/${e.id}`}>{e.name}</Link><StatusBadge status={e.phase} label={m.enums.eventPhase[e.phase]} /></li>
                ))}
                {o.booths.map((x) => (
                  <li key={x.id} className="flex items-center justify-between px-4 py-2"><Link className="hover:text-primary" href={`${b}/production/${x.id}`}>{x.name}</Link><StatusBadge status="ACTIVE" label={m.enums.boothStage[x.stage]} /></li>
                ))}
              </ul>
            </Section>
          )}
          {!o.scope.clientView && (
            <Section title={m.projects.activity} actions={<Link href={`${b}/activity`} className="text-xs text-primary">{m.common.view}</Link>}>
              <ul className="divide-y">
                {o.activity.slice(0, 6).map((a) => {
                  const d = describeAudit(a, m, fmt.locale);
                  return (
                    <li key={a.id} className="px-4 py-2 text-xs">
                      <span className="font-medium"><bdi>{d.actor}</bdi></span> <span className="text-muted-foreground">· {d.title}</span>
                      {d.detail && <div className="truncate text-muted-foreground"><bdi>{d.detail}</bdi></div>}
                      <div className="text-[11px] text-muted-foreground">{formatRelative(a.createdAt, fmt)}</div>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

export default guardPage(ProjectOverviewPage);
