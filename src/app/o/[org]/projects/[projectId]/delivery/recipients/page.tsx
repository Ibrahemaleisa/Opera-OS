import { getI18n } from "@/lib/i18n/server";
import { can } from "@/server/authz/policy";
import { listCampaigns } from "@/server/modules/delivery/analytics";
import { listRecipients } from "@/server/modules/delivery/service";
import { requirePageContext } from "@/server/request";
import { RecipientRegistry } from "@/components/delivery/recipient-registry";
import { guardPage } from "@/server/page-guard";

async function ProjectRecipientsPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  await getI18n();
  const [data, campaigns] = await Promise.all([listRecipients(ctx, { projectId }), listCampaigns(ctx, projectId)]);
  return <RecipientRegistry orgSlug={org} rows={JSON.parse(JSON.stringify(data.rows))} vip={data.vip} campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))} projectId={projectId} canManage={can(ctx, "recipient.manage")} />;
}

export default guardPage(ProjectRecipientsPage);
