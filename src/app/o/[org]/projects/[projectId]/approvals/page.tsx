import { EmptyState, Section } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { listProjectApprovals } from "@/server/modules/approvals/service";
import { listChangeRequests } from "@/server/modules/portal/service";
import { requirePageContext } from "@/server/request";
import { ApprovalsList } from "./approvals-list";
import { ChangeRequests } from "./change-requests";
import { guardPage } from "@/server/page-guard";

async function ApprovalsPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const { m } = await getI18n();
  const [data, requests] = await Promise.all([listProjectApprovals(ctx, projectId), listChangeRequests(ctx, projectId)]);
  return (
    <div className="grid gap-4">
      {data.approvals.length ? <ApprovalsList orgSlug={org} approvals={JSON.parse(JSON.stringify(data.approvals))} users={data.users} canDecide={data.scope.approve} /> : <Section><EmptyState title={m.common.emptyTitle} /></Section>}
      {requests.rows.length > 0 && <ChangeRequests orgSlug={org} rows={requests.rows} canRespond={requests.canRespond} />}
    </div>
  );
}

export default guardPage(ApprovalsPage);
