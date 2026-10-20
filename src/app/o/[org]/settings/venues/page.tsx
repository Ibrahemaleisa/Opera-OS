import { PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan } from "@/server/authz/policy";
import { listVenues } from "@/server/modules/org/service";
import { requirePageContext } from "@/server/request";
import { VenuesClient } from "./venues-client";
import { guardPage } from "@/server/page-guard";

async function VenuesPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "org.directory.manage");
  const { m } = await getI18n();
  const venues = await listVenues(ctx);
  return (
    <>
      <PageHeader title={m.org.venuesTitle} description={m.org.venuesDesc} />
      <VenuesClient orgSlug={org} venues={venues.map(({ createdAt, _count, ...v }) => ({ ...v, projects: _count.projects }))} />
    </>
  );
}

export default guardPage(VenuesPage);
