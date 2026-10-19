import { CampaignList } from "@/components/digital/campaign-list";
import { getI18n } from "@/lib/i18n/server";
import { can } from "@/server/authz/policy";
import { listDigitalCampaigns } from "@/server/modules/digital/service";
import { requirePageContext } from "@/server/request";

export default async function ProjectDigitalPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  await getI18n();
  const campaigns = await listDigitalCampaigns(ctx, projectId);
  return <CampaignList orgSlug={org} projectId={projectId} campaigns={JSON.parse(JSON.stringify(campaigns))} canCreate={can(ctx, "campaign.manage")} />;
}
