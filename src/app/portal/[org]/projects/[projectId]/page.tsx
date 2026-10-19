import { notFound } from "next/navigation";
import { NotFoundError } from "@/server/errors";
import { portalProject } from "@/server/modules/portal/service";
import { requirePageContext } from "@/server/request";
import { PortalProject } from "./portal-project";

export default async function PortalProjectPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const data = await portalProject(ctx, projectId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  return <PortalProject orgSlug={org} data={data} />;
}
