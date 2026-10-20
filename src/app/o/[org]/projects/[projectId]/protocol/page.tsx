import { notFound } from "next/navigation";
import { ProtocolBoard } from "@/components/protocol/protocol-board";
import { NotFoundError } from "@/server/errors";
import { listGuests } from "@/server/modules/protocol/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

async function ProjectProtocolPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const data = await listGuests(ctx, projectId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  return <ProtocolBoard orgSlug={org} projectId={projectId} data={data} />;
}

export default guardPage(ProjectProtocolPage);
