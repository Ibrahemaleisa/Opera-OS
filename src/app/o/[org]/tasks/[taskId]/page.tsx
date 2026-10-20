import { notFound } from "next/navigation";
import { PageBody } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { NotFoundError } from "@/server/errors";
import { getTaskDetail } from "@/server/modules/tasks/service";
import { requirePageContext } from "@/server/request";
import { TaskDetail } from "./task-detail";
import { guardPage } from "@/server/page-guard";

async function TaskPage({ params }: { params: Promise<{ org: string; taskId: string }> }) {
  const { org, taskId } = await params;
  const ctx = await requirePageContext(org);
  await getI18n();
  const d = await getTaskDetail(ctx, taskId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  return (
    <PageBody className="max-w-6xl">
      <TaskDetail orgSlug={org} data={JSON.parse(JSON.stringify(d))} />
    </PageBody>
  );
}

export default guardPage(TaskPage);
