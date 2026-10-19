import { PageBody, PageHeader } from "@/components/app/page";
import { CampaignList } from "@/components/digital/campaign-list";
import { getI18n } from "@/lib/i18n/server";
import { listDigitalCampaigns } from "@/server/modules/digital/service";
import { requirePageContext } from "@/server/request";

export default async function OrgDigitalPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m } = await getI18n();
  const campaigns = await listDigitalCampaigns(ctx);
  return (
    <PageBody>
      <PageHeader title={m.digital.title} description={m.digital.desc} />
      <CampaignList orgSlug={org} campaigns={JSON.parse(JSON.stringify(campaigns))} canCreate={false} />
    </PageBody>
  );
}
