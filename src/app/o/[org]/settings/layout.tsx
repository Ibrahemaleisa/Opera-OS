import { TabNav } from "@/components/app/tab-nav";
import { PageBody } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { can } from "@/server/authz/policy";
import { requirePageContext } from "@/server/request";
import { canViewSystemHealth } from "@/server/modules/recovery/service";

export default async function SettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m } = await getI18n();
  const b = `/o/${org}/settings`;
  const t = m.org.tabs;
  const items = [
    ...(can(ctx, "org.manage") ? [{ href: b, label: t.general, exact: true }] : []),
    ...(can(ctx, "org.members.view") ? [{ href: `${b}/members`, label: t.members }] : []),
    ...(can(ctx, "org.directory.manage") ? [{ href: `${b}/clients`, label: t.clients }, { href: `${b}/venues`, label: t.venues }] : []),
    ...(can(ctx, "org.customFields.manage") ? [{ href: `${b}/fields`, label: t.fields }] : []),
    ...(can(ctx, "automation.manage") ? [{ href: `${b}/automation`, label: t.automation }] : []),
    ...(can(ctx, "campaign.manage") ? [{ href: `${b}/providers`, label: t.providers }] : []),
    ...(can(ctx, "org.audit.view") ? [{ href: `${b}/audit`, label: t.audit }] : []),
    ...(can(ctx, "org.manage") ? [{ href: `${b}/security`, label: m.auth.security.tab }] : []),
    ...(canViewSystemHealth(ctx) ? [{ href: `${b}/health`, label: m.health.tab }] : []),
  ];
  return (
    <PageBody>
      <TabNav items={items} className="mb-5" />
      {children}
    </PageBody>
  );
}
