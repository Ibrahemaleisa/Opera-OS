import { EmptyState, Section } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { listProjectApprovals } from "@/server/modules/approvals/service";
import { requirePageContext } from "@/server/request";
import { ApprovalsList } from "./approvals-list";

export default async function ApprovalsPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const { m } = await getI18n();
  const data = await listProjectApprovals(ctx, projectId);
  if (!data.approvals.length) return <Section><EmptyState title={m.common.emptyTitle} /></Section>;
  return <ApprovalsList orgSlug={org} approvals={JSON.parse(JSON.stringify(data.approvals))} users={data.users} canDecide={data.scope.approve} />;
}
