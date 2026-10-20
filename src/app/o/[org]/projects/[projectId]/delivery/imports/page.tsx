import Link from "next/link";
import { EmptyState, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { formatDateTime } from "@/lib/format";
import { getI18n } from "@/lib/i18n/server";
import { assertCan } from "@/server/authz/policy";
import { listCampaigns } from "@/server/modules/delivery/analytics";
import { listImports } from "@/server/modules/delivery/imports/service";
import { requirePageContext } from "@/server/request";
import { UploadImport } from "./upload";
import { guardPage } from "@/server/page-guard";

async function ImportsPage({ params, searchParams }: { params: Promise<{ org: string; projectId: string }>; searchParams: Promise<{ c?: string }> }) {
  const { org, projectId } = await params;
  const { c } = await searchParams;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "recipient.import");
  const { m, fmt } = await getI18n();
  const [imports, campaigns] = await Promise.all([listImports(ctx, projectId), listCampaigns(ctx, projectId)]);
  const im = m.delivery.import;
  return (
    <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
      <Section title={im.upload} description={im.dropHint}>
        <UploadImport orgSlug={org} projectId={projectId} campaigns={campaigns.map((x) => ({ id: x.id, name: x.name }))} defaultCampaign={c ?? campaigns[0]?.id ?? ""} />
      </Section>
      <Section title={im.history}>
        {imports.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
          <ul className="divide-y">
            {imports.map((b) => (
              <li key={b.id}>
                <Link href={`/o/${org}/projects/${projectId}/delivery/imports/${b.id}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-muted/40" data-testid="import-history-row">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{b.fileName}</div>
                    <div className="tabular text-[11px] text-muted-foreground">{formatDateTime(b.createdAt, fmt)} · {b.totalRows} {im.rows} · {b.committedRows} ✓</div>
                  </div>
                  <StatusBadge status={b.status} label={m.enums.importStatus[b.status]} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

export default guardPage(ImportsPage);
