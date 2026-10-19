import { notFound } from "next/navigation";
import { CampaignDetail } from "@/components/digital/campaign-detail";
import { getI18n } from "@/lib/i18n/server";
import { NotFoundError } from "@/server/errors";
import { getDigitalCampaign } from "@/server/modules/digital/service";
import { requirePageContext } from "@/server/request";

export default async function CampaignPage({ params }: { params: Promise<{ org: string; projectId: string; campaignId: string }> }) {
  const { org, projectId, campaignId } = await params;
  const ctx = await requirePageContext(org);
  await getI18n();
  const d = await getDigitalCampaign(ctx, campaignId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  return <CampaignDetail orgSlug={org} projectId={projectId} data={JSON.parse(JSON.stringify(d))} currentUserId={ctx.userId} />;
}
