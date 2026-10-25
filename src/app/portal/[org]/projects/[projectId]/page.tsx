import { notFound } from "next/navigation";
import { NotFoundError } from "@/server/errors";
import { portalProject } from "@/server/modules/portal/service";
import { requirePageContext } from "@/server/request";
import { PortalProject } from "./portal-project";
import { guardPage } from "@/server/page-guard";

async function PortalProjectPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org, "portal");
  const data = await portalProject(ctx, projectId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  return <PortalProject orgSlug={org} data={data} />;
}

export default guardPage(PortalProjectPage);
