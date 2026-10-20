import { PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan, can } from "@/server/authz/policy";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listMembers } from "@/server/modules/org/service";
import { requirePageContext } from "@/server/request";
import { withTenant } from "@/server/db/tenant";
import { MembersClient } from "./members-client";
import { guardPage } from "@/server/page-guard";

async function MembersPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "org.members.view");
  const { m } = await getI18n();
  const data = await listMembers(ctx);
  const projects = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => tx.project.findMany({ where: { archivedAt: null }, select: { id: true, name: true, code: true }, orderBy: { createdAt: "desc" } }));
  return (
    <>
      <PageHeader title={m.org.membersTitle} description={m.org.membersDesc} />
      <MembersClient
        orgSlug={org}
        canManage={can(ctx, "org.members.manage")}
        canManageRoles={can(ctx, "org.roles.manage")}
        currentUserId={ctx.userId}
        members={data.members.map((x) => ({ id: x.id, userId: x.userId, name: x.user.nameAr ?? x.user.name, nameEn: x.user.name, email: x.user.email, status: x.status, roleId: x.roleId, baseRole: x.role.baseRole, lastLoginAt: x.user.lastLoginAt?.toISOString() ?? null, clientId: x.clientId, vendorId: x.vendorId }))}
        invitations={data.invitations.map((i) => ({ id: i.id, email: i.email, roleId: i.roleId, expiresAt: i.expiresAt.toISOString() }))}
        roles={data.roles.map((r) => ({ id: r.id, key: r.key, nameAr: r.nameAr, nameEn: r.nameEn, baseRole: r.baseRole, isSystem: r.isSystem, permissions: r.permissions }))}
        clients={data.clients}
        vendors={data.vendors}
        projects={projects}
        permissionCatalog={Object.keys(PERMISSIONS)}
      />
    </>
  );
}

export default guardPage(MembersPage);
