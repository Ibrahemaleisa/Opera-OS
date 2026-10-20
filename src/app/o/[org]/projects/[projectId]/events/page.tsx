import { notFound } from "next/navigation";
import { EventList } from "@/components/events/event-list";
import { NotFoundError } from "@/server/errors";
import { listProjectEvents } from "@/server/modules/events/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

async function ProjectEventsPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const data = await listProjectEvents(ctx, projectId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  return <EventList orgSlug={org} projectId={projectId} events={data.events} canManage={data.canManage} />;
}

export default guardPage(ProjectEventsPage);
