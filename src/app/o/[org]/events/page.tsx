import Link from "next/link";
import { AlertTriangle, Radio } from "lucide-react";
import { EmptyState, PageBody, PageHeader, ProgressBar, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { AutoRefresh } from "@/components/app/auto-refresh";
import { formatDateTime, formatTime } from "@/lib/format";
import { getI18n } from "@/lib/i18n/server";
import { commandCenter } from "@/server/modules/events/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

export const dynamic = "force-dynamic";

async function CommandCenterPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m, fmt } = await getI18n();
  const t = m.events;
  const data = await commandCenter(ctx);
  const b = `/o/${org}/projects`;
  return (
    <PageBody>
      <AutoRefresh seconds={30} />
      <PageHeader title={t.commandCenter} description={t.commandDesc} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid content-start gap-3">
          {data.events.length === 0 && <EmptyState title={t.noEvents} />}
          {data.events.map((e) => {
            const live = e.phase === "LIVE" || (e.startsAt <= data.now && e.endsAt >= data.now);
            return (
              <Link key={e.id} href={`${b}/${e.project.id}/events/${e.id}`} className="grid gap-3 rounded-xl border bg-card p-4 hover:border-primary/40" data-testid="cc-event">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{e.name}</span>
                  <StatusBadge status={e.phase} label={m.enums.eventPhase[e.phase]} />
                  {live && <span className="flex items-center gap-1 rounded bg-danger-soft px-2 py-0.5 text-[11px] text-danger"><Radio className="size-3 animate-pulse" /> {t.live}</span>}
                  <span className="ltr-nums ms-auto text-xs text-muted-foreground">{e.project.code} · {formatDateTime(e.startsAt, fmt)}</span>
                </div>
                <div className="grid gap-3 text-xs sm:grid-cols-4">
                  <div><div className="mb-1 text-muted-foreground">{t.readiness} {e.readiness.ready}/{e.readiness.total}</div><ProgressBar value={e.readiness.total ? (e.readiness.ready / e.readiness.total) * 100 : 0} tone={e.readiness.issues ? "danger" : "brand"} /></div>
                  <div><div className="text-muted-foreground">{t.nowLive}</div><div className="font-medium">{e.currentCue?.title ?? "—"}</div><div className="text-muted-foreground">{e.nextCue ? `${t.upNext}: ${formatTime(e.nextCue.startsAt, fmt)} ${e.nextCue.title}` : ""}</div></div>
                  <div><div className="text-muted-foreground">{t.staffOnSite}</div><div className="tabular font-medium">{e.staff.checkedIn}/{e.staff.due}{e.staff.noShow ? <span className="text-danger"> · {e.staff.noShow} {t.noShow}</span> : null}</div></div>
                  <div><div className="text-muted-foreground">{t.guestsArrived}</div><div className="tabular font-medium">{e.guests.arrived}/{e.guests.expected}</div>{e.incidents > 0 && <div className="flex items-center gap-1 text-danger"><AlertTriangle className="size-3" /> {e.incidents}</div>}</div>
                </div>
              </Link>
            );
          })}
        </div>
        <Section title={`${t.openIncidents} (${data.incidents.length})`}>
          {data.incidents.length === 0 ? <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t.noIncidents}</p> : (
            <ul className="divide-y">
              {data.incidents.map((i) => (
                <li key={i.id}>
                  <Link href={`${b}/${i.projectId}/events${i.eventId ? `/${i.eventId}?tab=incidents` : ""}`} className="grid gap-1 px-4 py-2.5 hover:bg-muted/40">
                    <div className="flex items-center gap-2"><StatusBadge status={i.severity === "CRITICAL" || i.severity === "HIGH" ? "FAILED" : "WARNING"} label={m.enums.severity[i.severity]} /><span className="text-[13px] font-medium">{i.title}</span></div>
                    <div className="ltr-nums text-[11px] text-muted-foreground">{i.project.code} · {m.enums.incidentStatus[i.status]} · {formatTime(i.createdAt, fmt)}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </PageBody>
  );
}

export default guardPage(CommandCenterPage);
