import { CheckInDesk } from "@/components/digital/check-in";
import { getI18n } from "@/lib/i18n/server";
import { getDigitalCampaign } from "@/server/modules/digital/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

async function CheckInPage({ params }: { params: Promise<{ org: string; projectId: string; campaignId: string }> }) {
  const { org, campaignId } = await params;
  const ctx = await requirePageContext(org);
  await getI18n();
  const d = await getDigitalCampaign(ctx, campaignId);
  return <CheckInDesk orgSlug={org} campaignId={campaignId} name={d.campaign.name} total={d.invitations.filter((i) => i.rsvpStatus === "ATTENDING").length} checkedIn={d.invitations.filter((i) => i.checkedInAt).length} />;
}

export default guardPage(CheckInPage);
