import Link from "next/link";
import { PageBody } from "@/components/app/page";
import { NeedsYou } from "@/components/operations/board";
import { OnSiteToday, OwnedRisks, ProjectGaps, Queue, WaitingOnOthers } from "@/components/operations/my-work";
import { StatusRing } from "@/components/brand/status-ring";
import { interpolate } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { cn } from "@/lib/utils";
import { can } from "@/server/authz/policy";
import { myCommitments } from "@/server/modules/operations/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

const FILTERS = ["all", "tasks", "decisions", "duties"] as const;
type Filter = (typeof FILTERS)[number];
const DUTIES = new Set(["readiness", "incident", "snag", "shift", "cue"]);

async function MyWorkPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ f?: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { f } = await searchParams;
  const filter: Filter = (FILTERS as readonly string[]).includes(f ?? "") ? (f as Filter) : "all";
  const { m, fmt } = await getI18n();
  const d = await myCommitments(ctx);
  const base = `/o/${org}`;
  const t = m.ops.my;

  const items = d.items.filter((i) => (filter === "tasks" ? i.kind === "task" : filter === "duties" ? DUTIES.has(i.kind) : filter === "decisions" ? false : true));
  const count = (k: Filter) => (k === "decisions" ? d.awaiting.length : k === "tasks" ? d.items.filter((i) => i.kind === "task").length : k === "duties" ? d.items.filter((i) => DUTIES.has(i.kind)).length + d.onSite.length : d.items.length + d.awaiting.length);
  const overdue = d.items.filter((i) => i.bucket === "overdue").length;
  const today = d.items.filter((i) => i.bucket === "today").length;
  const nothing = d.items.length === 0 && d.awaiting.length === 0 && d.onSite.length === 0;
  const leader = can(ctx, "report.view");
  const side = d.onSite.length + d.gaps.length + d.waiting.length + d.risks.length > 0;

  return (
    <PageBody>
      <header className="mb-6 flex flex-col gap-3">
        <div>
          <h1 className="page-title">{t.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>
        </div>
        {!nothing && (
          <>
            <p className="flex flex-wrap gap-x-3 text-sm">
              <span className={cn("tabular", overdue ? "font-medium text-danger" : "text-muted-foreground")}>{interpolate(t.summary.overdue, { n: overdue })}</span>
              <span className="tabular text-muted-foreground">{interpolate(t.summary.today, { n: today })}</span>
              <span className={cn("tabular", d.awaiting.length ? "font-medium text-foreground" : "text-muted-foreground")}>{interpolate(t.summary.decisions, { n: d.awaiting.length })}</span>
            </p>
            <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label={t.title}>
              {FILTERS.map((k) => (
                <Link key={k} href={k === "all" ? `${base}/my-work` : `${base}/my-work?f=${k}`} aria-current={filter === k ? "page" : undefined} className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors", filter === k ? "border-primary bg-brand-soft font-medium text-primary" : "border-border text-muted-foreground hover:border-input hover:text-foreground")}>
                  {t.filter[k]}
                  <span className="tabular opacity-70">{count(k)}</span>
                </Link>
              ))}
            </nav>
          </>
        )}
      </header>

      {nothing ? (
        <div className="grid gap-8 lg:grid-cols-12">
          <div className="flex items-start gap-3 lg:col-span-8">
            <StatusRing state="complete" size={22} />
            <div>
              <p className="text-sm font-medium">{t.emptyTitle}</p>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">{leader ? t.emptyLeader : t.emptyBody}</p>
              {leader && <Link href={base} className="mt-3 inline-block text-sm text-primary hover:underline">{t.openOperations}</Link>}
            </div>
          </div>
          {side && (
            <aside className="grid content-start gap-8 lg:col-span-4">
              <ProjectGaps gaps={d.gaps} m={m} base={base} />
              <OwnedRisks risks={d.risks} m={m} base={base} />
            </aside>
          )}
        </div>
      ) : (
        <div className="grid gap-x-8 gap-y-8 lg:grid-cols-12">
          <div className={cn("grid content-start gap-8", side ? "lg:col-span-8" : "lg:col-span-12 xl:col-span-9")}>
            {(filter === "all" || filter === "decisions") && (d.awaiting.length > 0 || filter === "decisions") && <NeedsYou awaiting={d.awaiting} now={d.now} m={m} fmt={fmt} base={base} />}
            {filter !== "decisions" && (
              items.length ? <Queue items={items} now={d.now} m={m} fmt={fmt} base={base} /> : (
                <div className="flex items-start gap-3">
                  <StatusRing state="complete" size={18} />
                  <div>
                    <p className="text-sm font-medium">{filter === "all" ? t.emptyTitle : m.common.none}</p>
                    {filter === "all" && <p className="mt-1 max-w-xl text-sm text-muted-foreground">{leader ? t.emptyLeader : t.emptyBody}</p>}
                    {filter === "all" && leader && <Link href={base} className="mt-2 inline-block text-sm text-primary hover:underline">{t.openOperations}</Link>}
                  </div>
                </div>
              )
            )}
          </div>
          {side && (
            <aside className="grid content-start gap-8 lg:col-span-4">
              <OnSiteToday items={d.onSite} now={d.now} m={m} fmt={fmt} base={base} />
              <ProjectGaps gaps={d.gaps} m={m} base={base} />
              <WaitingOnOthers items={d.waiting} now={d.now} m={m} fmt={fmt} base={base} />
              <OwnedRisks risks={d.risks} m={m} base={base} />
            </aside>
          )}
        </div>
      )}
    </PageBody>
  );
}

export default guardPage(MyWorkPage);
