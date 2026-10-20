import { notFound } from "next/navigation";
import { Procurement } from "@/components/vendors/procurement";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { getProjectHeader } from "@/server/modules/projects/service";
import { listProcurement } from "@/server/modules/vendors/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

async function ProjectProcurementPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const [data, header] = await Promise.all([listProcurement(ctx, projectId), getProjectHeader(ctx, projectId)]).catch((e) => {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound();
    throw e;
  });
  return <Procurement orgSlug={org} projectId={projectId} currency={header.currency} data={data} />;
}

export default guardPage(ProjectProcurementPage);
