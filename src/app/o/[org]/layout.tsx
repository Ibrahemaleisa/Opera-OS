import { redirect } from "next/navigation";
import { AppShell } from "@/components/app/app-shell";
import { getI18n } from "@/lib/i18n/server";
import { listUserOrganizations } from "@/server/authz/load-context";
import { isClientRole } from "@/server/authz/roles";
import { withTenant } from "@/server/db/tenant";
import { buildNav } from "@/server/nav";
import { requirePageContext } from "@/server/request";

export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await requirePageContext(slug);
  // External roles never see the agency workspace.
  if (isClientRole(ctx.role)) redirect(`/portal/${slug}`);
  if (ctx.role === "FIELD_AGENT") redirect(`/field/${slug}`);
  if (ctx.role === "VENDOR") redirect(`/vendor/${slug}`);

  const { m, locale } = await getI18n();
  // One tenant transaction for the shell: each transaction costs several database round trips.
  const [{ org, unread }, orgs] = await Promise.all([
    withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { slug: true, name: true, nameEn: true, brandColor: true } });
      const unread = await tx.notification.count({ where: { userId: ctx.userId, readAt: null } });
      return { org, unread };
    }),
    listUserOrganizations(ctx.userId),
  ]);
  const orgName = (locale === "en" && org.nameEn) || org.name;
  return (
    <AppShell
      org={{ slug: org.slug, name: orgName, brandColor: org.brandColor }}
      user={{ name: ctx.userName, email: "", roleLabel: m.enums.orgRole[ctx.role] }}
      orgs={orgs.map((o) => ({ slug: o.organization.slug, name: (locale === "en" && o.organization.nameEn) || o.organization.name, brandColor: o.organization.brandColor }))}
      nav={buildNav(ctx, m, { notifications: unread })}
      unread={unread}
    >
      {children}
    </AppShell>
  );
}
