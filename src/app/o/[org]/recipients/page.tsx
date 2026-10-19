import { PageBody, PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { listRecipients } from "@/server/modules/delivery/service";
import { requirePageContext } from "@/server/request";
import { RecipientRegistry } from "@/components/delivery/recipient-registry";

export default async function OrgRecipientsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m } = await getI18n();
  const data = await listRecipients(ctx);
  return (
    <PageBody>
      <PageHeader title={m.delivery.registry.title} description={m.delivery.registry.desc} />
      <RecipientRegistry orgSlug={org} rows={JSON.parse(JSON.stringify(data.rows))} vip={data.vip} campaigns={[]} canManage={false} showProject />
    </PageBody>
  );
}
