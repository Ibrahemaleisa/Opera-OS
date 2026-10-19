import { Truck } from "lucide-react";
import { EmptyState, PageBody, PageHeader, Section } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan } from "@/server/authz/policy";
import { orgDeliveryOverview } from "@/server/modules/delivery/analytics";
import { listAgents, listDeliveries } from "@/server/modules/delivery/service";
import { requirePageContext } from "@/server/request";
import { withTenant } from "@/server/db/tenant";
import { DispatchBoard } from "./dispatch-board";

export default async function DispatchPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ project?: string; campaign?: string; view?: string }> }) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "delivery.dispatch");
  const { m } = await getI18n();
  const campaigns = await orgDeliveryOverview(ctx);
  const current = campaigns.find((c) => c.id === sp.campaign) ?? campaigns.find((c) => c.project.id === sp.project) ?? campaigns[0];
  if (!current) return <PageBody><PageHeader title={m.delivery.dispatch.title} description={m.delivery.dispatch.desc} /><Section><EmptyState icon={<Truck />} title={m.delivery.noCampaign} /></Section></PageBody>;
  const [data, agents, batches] = await Promise.all([
    listDeliveries(ctx, current.project.id, { campaignId: current.id }),
    listAgents(ctx),
    withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => tx.deliveryBatch.findMany({ where: { campaignId: current.id }, orderBy: { createdAt: "desc" } })),
  ]);
  return (
    <PageBody className="max-w-none">
      <PageHeader title={m.delivery.dispatch.title} description={m.delivery.dispatch.desc} />
      <DispatchBoard
        orgSlug={org}
        projectId={current.project.id}
        campaignId={current.id}
        campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, project: c.project.code }))}
        deliveries={JSON.parse(JSON.stringify(data.deliveries))}
        agents={agents}
        batches={batches.map((b) => ({ id: b.id, code: b.code, name: b.name }))}
        view={sp.view ?? "board"}
      />
    </PageBody>
  );
}
