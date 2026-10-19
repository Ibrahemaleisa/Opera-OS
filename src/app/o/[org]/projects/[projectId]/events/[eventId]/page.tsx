import { notFound } from "next/navigation";
import { EventWorkspace } from "@/components/events/event-workspace";
import { NotFoundError } from "@/server/errors";
import { getEventWorkspace } from "@/server/modules/events/service";
import { requirePageContext } from "@/server/request";

export default async function EventPage({ params }: { params: Promise<{ org: string; projectId: string; eventId: string }> }) {
  const { org, projectId, eventId } = await params;
  const ctx = await requirePageContext(org);
  const data = await getEventWorkspace(ctx, eventId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  if (data.project.id !== projectId) notFound();
  return <EventWorkspace orgSlug={org} data={data} />;
}
