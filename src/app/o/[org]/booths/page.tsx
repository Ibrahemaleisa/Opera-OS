import { BoothList } from "@/components/booths/booth-list";
import { PageBody, PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan } from "@/server/authz/policy";
import { listBooths } from "@/server/modules/booths/service";
import { requirePageContext } from "@/server/request";

export default async function BoothsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "booth.manage");
  const { m } = await getI18n();
  const data = await listBooths(ctx);
  return (
    <PageBody>
      <PageHeader title={m.booths.title} description={m.booths.desc} />
      <BoothList orgSlug={org} data={data} />
    </PageBody>
  );
}
