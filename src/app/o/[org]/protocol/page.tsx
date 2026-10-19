import Link from "next/link";
import { Lock } from "lucide-react";
import { AutoRefresh } from "@/components/app/auto-refresh";
import { EmptyState, PageBody, PageHeader, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { formatDateTime, formatTime } from "@/lib/format";
import { getI18n } from "@/lib/i18n/server";
import { arrivalsBoard } from "@/server/modules/protocol/service";
import { requirePageContext } from "@/server/request";

export const dynamic = "force-dynamic";

export default async function ArrivalsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m, fmt } = await getI18n();
  const t = m.protocol;
  const data = await arrivalsBoard(ctx);
  return (
    <PageBody>
      <AutoRefresh seconds={30} />
      <PageHeader title={t.arrivals} description={t.arrivalsDesc} />
      {data.events.length === 0 ? <EmptyState title={m.events.noEvents} /> : (
        <div className="grid gap-4">
          {data.events.map((e) => {
            const guests = data.guests.filter((g) => g.eventId === e.id || (g.eventId === null && g.projectId === e.project.id));
            return (
              <Section key={e.id} title={<Link className="hover:underline" href={`/o/${org}/projects/${e.project.id}/protocol`}>{e.name}</Link>} description={<span className="ltr-nums">{e.project.code} · {formatDateTime(e.startsAt, fmt)}</span>}>
                {guests.length === 0 ? <p className="px-4 py-4 text-xs text-muted-foreground">{m.common.none}</p> : (
                  <ul className="divide-y">
                    {guests.map((g) => (
                      <li key={g.id} className="grid gap-1 px-4 py-2.5 text-sm md:grid-cols-[40px_1fr_160px_140px] md:items-center">
                        <span className="tabular inline-flex size-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">{g.protocolLevel}</span>
                        <div><div className="flex items-center gap-1 font-medium">{g.honorific} {g.displayName}{g.hasRestricted && <Lock className="size-3 text-warning" />}</div><div className="text-[11px] text-muted-foreground">{g.organizationName}</div></div>
                        <span className="ltr-nums text-xs text-muted-foreground">{g.arrivalAt ? formatTime(g.arrivalAt, fmt) : "—"}{g.arrivalPoint ? ` · ${g.arrivalPoint}` : ""}</span>
                        <StatusBadge status={g.attendance === "ARRIVED" || g.attendance === "SEATED" ? "DELIVERED" : g.attendance === "NO_SHOW" ? "FAILED" : g.attendance} label={m.enums.attendance[g.attendance]} />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            );
          })}
        </div>
      )}
    </PageBody>
  );
}
