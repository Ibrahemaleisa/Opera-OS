import { PageBody, PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { resourceBoard } from "@/server/modules/resources/service";
import { requirePageContext } from "@/server/request";
import { ResourceBoard } from "./resource-board";

export default async function ResourcesPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m } = await getI18n();
  const data = await resourceBoard(ctx);
  return (
    <PageBody>
      <PageHeader title={m.resources.title} description={m.resources.desc} />
      <ResourceBoard orgSlug={org} data={data} />
    </PageBody>
  );
}
