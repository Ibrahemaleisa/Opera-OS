import { Download, FileSpreadsheet, ShieldCheck } from "lucide-react";
import { EmptyState, PageBody, PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { availableReports } from "@/server/modules/reports/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

async function ReportsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m } = await getI18n();
  const t = m.reports;
  const kinds = availableReports(ctx);
  return (
    <PageBody>
      <PageHeader title={t.title} description={t.desc} />
      {kinds.length === 0 ? <EmptyState title={t.none} /> : (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {kinds.map((k) => (
              <div key={k} className="grid gap-3 rounded-xl border bg-card p-4">
                <div className="flex items-start gap-3"><FileSpreadsheet className="mt-0.5 size-5 text-primary" /><div><div className="font-medium">{t.kinds[k].title}</div><p className="text-xs text-muted-foreground">{t.kinds[k].desc}</p></div></div>
                <a href={`/api/o/${org}/reports/${k}`} className="inline-flex w-fit items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted" data-testid={`report-${k}`}><Download className="size-3.5" /> {t.download}</a>
              </div>
            ))}
          </div>
          <p className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" /> {t.privacy}</p>
        </div>
      )}
    </PageBody>
  );
}

export default guardPage(ReportsPage);
