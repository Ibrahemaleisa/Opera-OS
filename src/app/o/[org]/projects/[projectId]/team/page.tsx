import { getI18n } from "@/lib/i18n/server";
import { getProjectOverview } from "@/server/modules/projects/service";
import { memberDirectory } from "@/server/modules/org/service";
import { requirePageContext } from "@/server/request";
import { TeamClient } from "./team-client";
import { guardPage } from "@/server/page-guard";

async function TeamPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  await getI18n();
  const o = await getProjectOverview(ctx, projectId);
  const people = o.scope.manage ? await memberDirectory(ctx) : [];
  return (
    <TeamClient
      orgSlug={org}
      projectId={projectId}
      canManage={o.scope.manage}
      members={o.members.map((x) => ({ userId: x.userId, name: x.user.nameAr ?? x.user.name, email: x.user.email, role: x.role, canViewFinance: x.canViewFinance, canViewVip: x.canViewVip, canExport: x.canExport, canApprove: x.canApprove, workstreamIds: x.workstreamIds }))}
      people={people}
      workstreams={o.workstreams.map((w) => ({ id: w.id, name: w.name }))}
    />
  );
}

export default guardPage(TeamPage);
