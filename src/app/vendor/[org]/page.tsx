import { EmptyState } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { vendorPortal } from "@/server/modules/vendors/service";
import { requirePageContext } from "@/server/request";
import { VendorWork } from "./vendor-work";
import { guardPage } from "@/server/page-guard";

async function VendorHome({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m } = await getI18n();
  if (!ctx.vendorId) return <EmptyState title={m.vendors.noWork} />;
  const data = await vendorPortal(ctx);
  return (
    <div className="grid gap-4">
      <div><h1 className="text-xl font-semibold">{data.vendor.name}</h1><p className="text-sm text-muted-foreground">{m.vendors.portalDesc}</p></div>
      <VendorWork orgSlug={org} workOrders={data.workOrders} />
    </div>
  );
}

export default guardPage(VendorHome);
