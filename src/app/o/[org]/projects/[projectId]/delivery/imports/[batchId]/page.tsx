import { notFound } from "next/navigation";
import { getI18n } from "@/lib/i18n/server";
import { NotFoundError } from "@/server/errors";
import { listCampaigns } from "@/server/modules/delivery/analytics";
import { getImportPreview, listImportRows } from "@/server/modules/delivery/imports/service";
import { requirePageContext } from "@/server/request";
import { ImportWizard } from "./wizard";
import { guardPage } from "@/server/page-guard";

async function ImportBatchPage({ params, searchParams }: { params: Promise<{ org: string; projectId: string; batchId: string }>; searchParams: Promise<{ status?: string }> }) {
  const { org, projectId, batchId } = await params;
  const { status } = await searchParams;
  const ctx = await requirePageContext(org);
  await getI18n();
  const rows = await listImportRows(ctx, batchId, { status, take: 1000 }).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const needsPreview = ["PARSED", "FAILED", "VALIDATED"].includes(rows.batch.status);
  const [preview, campaigns] = await Promise.all([needsPreview ? getImportPreview(ctx, batchId) : Promise.resolve(null), listCampaigns(ctx, projectId)]);
  return (
    <ImportWizard
      orgSlug={org}
      projectId={projectId}
      data={JSON.parse(JSON.stringify(rows))}
      preview={preview ? JSON.parse(JSON.stringify(preview)) : null}
      campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
      statusFilter={status ?? ""}
    />
  );
}

export default guardPage(ImportBatchPage);
