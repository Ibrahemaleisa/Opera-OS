import { SlimShell } from "@/components/app/slim-shell";
import { getI18n } from "@/lib/i18n/server";
import { withTenant } from "@/server/db/tenant";
import { unreadCount } from "@/server/modules/notifications/service";
import { requirePageContext } from "@/server/request";

export const metadata = { title: "Portal", robots: { index: false } };

export default async function PortalLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org, "portal");
  const { m, locale } = await getI18n();
  const [o, unread] = await Promise.all([withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true, nameEn: true, brandColor: true } })), unreadCount(ctx)]);
  return (
    <SlimShell orgName={(locale === "en" && o.nameEn) || o.name} brandColor={o.brandColor} homeHref={`/portal/${org}`} title={m.portal.title} unread={unread} notificationsHref={`/portal/${org}/notifications`} signOutLabel={m.portal.signOut}>
      {children}
    </SlimShell>
  );
}
