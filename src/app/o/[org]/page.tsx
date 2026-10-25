import { redirect } from "next/navigation";
import { PageBody } from "@/components/app/page";
import { EXCEPTION_FILTERS, ExceptionsPanel, NeedsYou, NextEvents, PortfolioList, SetupChecklist, SignalStrip } from "@/components/operations/board";
import { relativeDay } from "@/components/operations/primitives";
import { formatDual } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { operationsBoard, type ExceptionGroupKey } from "@/server/modules/operations/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

/** Roles whose day is their own work, not the agency's: they land on My work. */
const MY_WORK_LANDING = new Set(["TEAM_LEAD", "EMPLOYEE", "FREELANCER"]);

async function OperationsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ f?: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  if (MY_WORK_LANDING.has(ctx.role)) redirect(`/o/${org}/my-work`);
  const { f } = await searchParams;
  const filter = (EXCEPTION_FILTERS as string[]).includes(f ?? "") ? (f as "all" | ExceptionGroupKey) : "all";
  const { m, fmt } = await getI18n();
  const d = await operationsBoard(ctx);
  const base = `/o/${org}`;
  const t = m.ops;
  const next = d.nextEvents.find((e) => !e.live) ?? d.nextEvents[0];

  return (
    <PageBody>
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="page-title">{t.title}</h1>
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <span className="tabular">{formatDual(d.now, fmt)}</span>
          {d.projectCount > 0 && <span>· {interpolate(t.activeProjects, { n: d.projectCount })}</span>}
          {next ? <span>· {interpolate(t.nextEventIn, { when: relativeDay(next.startsAt, d.now, fmt.locale) })}</span> : d.projectCount > 0 && <span>· {t.noUpcomingEvent}</span>}
        </p>
      </header>

      {d.setup ? (
        <div className="grid gap-6">
          {d.awaiting.length > 0 && <NeedsYou awaiting={d.awaiting} now={d.now} m={m} fmt={fmt} base={base} />}
          <SetupChecklist setup={d.setup} m={m} base={base} />
        </div>
      ) : (
        <div className="grid gap-x-8 gap-y-8 lg:grid-cols-12">
          <div className="grid content-start gap-8 lg:col-span-8">
            <NeedsYou awaiting={d.awaiting} now={d.now} m={m} fmt={fmt} base={base} />
            <ExceptionsPanel groups={d.exceptions} filter={filter} m={m} fmt={fmt} now={d.now} base={base} hrefFor={(x) => (x === "all" ? base : `${base}?f=${x}`)} />
          </div>
          <aside className="lg:col-span-4">
            <div className="lg:sticky lg:top-20">
              <NextEvents events={d.nextEvents} beyondWindow={d.nextEventBeyondWindow} now={d.now} m={m} fmt={fmt} base={base} />
            </div>
          </aside>
          <div className="lg:col-span-12">
            <PortfolioList rows={d.portfolio} now={d.now} m={m} fmt={fmt} base={base} />
          </div>
          {d.signals && (
            <div className="lg:col-span-12">
              <SignalStrip signals={d.signals} m={m} fmt={fmt} base={base} />
            </div>
          )}
        </div>
      )}
    </PageBody>
  );
}

export default guardPage(OperationsPage);
