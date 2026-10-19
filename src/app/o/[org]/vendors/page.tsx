import { PageBody, PageHeader } from "@/components/app/page";
import { VendorDirectory } from "@/components/vendors/vendor-directory";
import { getI18n } from "@/lib/i18n/server";
import { listVendors } from "@/server/modules/vendors/service";
import { requirePageContext } from "@/server/request";

export default async function VendorsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m } = await getI18n();
  const data = await listVendors(ctx);
  return (
    <PageBody>
      <PageHeader title={m.vendors.title} description={m.vendors.desc} />
      <VendorDirectory orgSlug={org} data={data} />
    </PageBody>
  );
}
