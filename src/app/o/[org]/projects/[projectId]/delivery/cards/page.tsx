import { getI18n } from "@/lib/i18n/server";
import { can } from "@/server/authz/policy";
import { listCampaigns } from "@/server/modules/delivery/analytics";
import { listAgents, listDeliveries } from "@/server/modules/delivery/service";
import { requirePageContext } from "@/server/request";
import { DeliveryTable } from "@/components/delivery/delivery-table";

export default async function CardsPage({ params, searchParams }: { params: Promise<{ org: string; projectId: string }>; searchParams: Promise<{ c?: string; status?: string; agent?: string }> }) {
  const { org, projectId } = await params;
  const sp = await searchParams;
  const ctx = await requirePageContext(org);
  await getI18n();
  const campaigns = await listCampaigns(ctx, projectId);
  const campaignId = sp.c ?? campaigns[0]?.id;
  const [data, agents] = await Promise.all([listDeliveries(ctx, projectId, { campaignId, status: sp.status, agentId: sp.agent }), can(ctx, "delivery.dispatch") ? listAgents(ctx) : Promise.resolve([])]);
  return (
    <DeliveryTable
      orgSlug={org}
      projectId={projectId}
      campaignId={campaignId ?? ""}
      campaigns={campaigns.map((x) => ({ id: x.id, name: x.name }))}
      deliveries={JSON.parse(JSON.stringify(data.deliveries))}
      agents={agents}
      canDispatch={can(ctx, "delivery.dispatch")}
      statusFilter={sp.status ?? ""}
    />
  );
}
