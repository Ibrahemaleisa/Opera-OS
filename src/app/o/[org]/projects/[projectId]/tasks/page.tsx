import { getI18n } from "@/lib/i18n/server";
import { listProjectTasks } from "@/server/modules/tasks/service";
import { requirePageContext } from "@/server/request";
import { TaskViews } from "./task-views";

export default async function ProjectTasksPage({ params, searchParams }: { params: Promise<{ org: string; projectId: string }>; searchParams: Promise<{ view?: string; ws?: string; owner?: string; overdue?: string; category?: string; q?: string }> }) {
  const { org, projectId } = await params;
  const sp = await searchParams;
  const ctx = await requirePageContext(org);
  await getI18n();
  const data = await listProjectTasks(ctx, projectId, { workstreamId: sp.ws, ownerId: sp.owner, overdue: sp.overdue === "1", category: sp.category, q: sp.q });
  return (
    <TaskViews
      orgSlug={org}
      projectId={projectId}
      view={sp.view ?? "board"}
      workstreamId={sp.ws ?? ""}
      tasks={JSON.parse(JSON.stringify(data.tasks))}
      workstreams={data.workstreams}
      members={data.members}
      canCreate={data.scope.operate && !data.scope.clientView && data.scope.taskScope === "all"}
      canBulk={data.scope.operate && data.scope.taskScope === "all"}
    />
  );
}
