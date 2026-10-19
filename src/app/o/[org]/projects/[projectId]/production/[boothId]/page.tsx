import { notFound } from "next/navigation";
import { BoothWorkspace } from "@/components/booths/booth-workspace";
import { NotFoundError } from "@/server/errors";
import { getBooth } from "@/server/modules/booths/service";
import { requirePageContext } from "@/server/request";

export default async function BoothPage({ params }: { params: Promise<{ org: string; projectId: string; boothId: string }> }) {
  const { org, projectId, boothId } = await params;
  const ctx = await requirePageContext(org);
  const data = await getBooth(ctx, boothId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  if (data.project.id !== projectId) notFound();
  return <BoothWorkspace orgSlug={org} data={data} />;
}
