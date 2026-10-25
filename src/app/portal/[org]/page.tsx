import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { EmptyState, ProgressBar } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { formatDate, formatPercent } from "@/lib/format";
import { getI18n } from "@/lib/i18n/server";
import { portalHome } from "@/server/modules/portal/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

async function PortalHome({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org, "portal");
  const { m, fmt } = await getI18n();
  const t = m.portal;
  const data = await portalHome(ctx);
  return (
    <div className="grid gap-6">
      <div><h1 className="text-2xl font-medium">{t.welcome}</h1><p className="mt-1 text-sm text-muted-foreground">{t.subtitle}</p></div>
      {data.projects.length === 0 ? <EmptyState title={t.noProjects} /> : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.projects.map((p) => (
            <Link key={p.id} href={`/portal/${org}/projects/${p.id}`} className="grid gap-3 rounded-xl border bg-card p-5 hover:border-primary/40" data-testid="portal-project">
              <div className="flex items-start justify-between gap-2"><div><div className="font-medium">{p.name}</div><div className="ltr-nums text-xs text-muted-foreground">{p.code}</div></div><StatusBadge status={p.status} label={m.enums.projectStatus[p.status]} /></div>
              {p.eventStartAt && <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><CalendarDays className="size-3.5" /> <time dateTime={new Date(p.eventStartAt).toISOString()} className="tabular [unicode-bidi:isolate]">{formatDate(p.eventStartAt, fmt)}</time></div>}
              <div><div className="mb-1 flex justify-between text-xs"><span>{t.progress}</span><span className="tabular">{formatPercent(p.progress.ratio, fmt)}</span></div><ProgressBar value={(p.progress.ratio ?? 0) * 100} /></div>
              {p.pendingApprovals > 0 && <span className="w-fit rounded bg-warning-soft px-2 py-0.5 text-xs text-warning">{t.pending}: {p.pendingApprovals}</span>}
            </Link>
          ))}
        </div>
      )}
      {data.pastProjects.length > 0 && (
        <section className="grid gap-2" data-testid="portal-past-projects">
          <div><h2 className="text-sm font-medium">{t.pastProjects}</h2><p className="text-xs text-muted-foreground">{t.pastHint}</p></div>
          <ul className="divide-y rounded-xl border bg-card">
            {data.pastProjects.map((p) => (
              <li key={p.id}>
                <Link href={`/portal/${org}/projects/${p.id}`} className="flex items-center justify-between gap-2 px-4 py-3 text-sm hover:bg-muted/40">
                  <span><span className="font-medium">{p.name}</span> <span className="ltr-nums text-xs text-muted-foreground">{p.code}</span></span>
                  <StatusBadge status={p.status} label={m.enums.projectStatus[p.status]} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default guardPage(PortalHome);
