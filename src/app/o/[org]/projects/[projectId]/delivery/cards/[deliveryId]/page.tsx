import { notFound } from "next/navigation";
import { getI18n } from "@/lib/i18n/server";
import { NotFoundError } from "@/server/errors";
import { getDelivery, listAgents } from "@/server/modules/delivery/service";
import { requirePageContext } from "@/server/request";
import { withTenant } from "@/server/db/tenant";
import { listComments } from "@/server/modules/tasks/service";
import { projectScope, can } from "@/server/authz/policy";
import { DeliveryCard } from "@/components/delivery/delivery-card";

export default async function DeliveryCardPage({ params }: { params: Promise<{ org: string; projectId: string; deliveryId: string }> }) {
  const { org, projectId, deliveryId } = await params;
  const ctx = await requirePageContext(org);
  await getI18n();
  const d = await getDelivery(ctx, deliveryId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const [agents, comments, members] = await Promise.all([
    can(ctx, "delivery.dispatch") ? listAgents(ctx) : Promise.resolve([]),
    withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => listComments(tx, await projectScope(tx, ctx, projectId), "DELIVERY", deliveryId)),
    withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => tx.projectMember.findMany({ where: { projectId }, include: { user: { select: { id: true, name: true, nameAr: true } } } })),
  ]);
  return <DeliveryCard orgSlug={org} projectId={projectId} data={JSON.parse(JSON.stringify(d))} agents={agents} comments={JSON.parse(JSON.stringify(comments))} members={members.map((x) => ({ id: x.userId, name: x.user.nameAr ?? x.user.name }))} />;
}
