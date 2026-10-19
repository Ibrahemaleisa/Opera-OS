import { notFound } from "next/navigation";
import { ProjectFinance } from "@/components/finance/project-finance";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { getProjectFinance } from "@/server/modules/finance/service";
import { requirePageContext } from "@/server/request";

export default async function ProjectFinancePage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const data = await getProjectFinance(ctx, projectId).catch((e) => {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound();
    throw e;
  });
  return <ProjectFinance orgSlug={org} data={data} />;
}
