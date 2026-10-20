import { notFound } from "next/navigation";
import { BoothList } from "@/components/booths/booth-list";
import { NotFoundError } from "@/server/errors";
import { listBooths } from "@/server/modules/booths/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

async function ProjectProductionPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const data = await listBooths(ctx, projectId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  return <BoothList orgSlug={org} projectId={projectId} data={data} />;
}

export default guardPage(ProjectProductionPage);
