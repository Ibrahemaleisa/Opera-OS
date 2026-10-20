import { NotificationsView } from "@/components/notifications/notifications-view";
import { listNotifications, listPreferences } from "@/server/modules/notifications/service";
import { EXTERNAL_NOTIFICATION_TYPES } from "@/server/modules/notifications/types";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

async function NotificationsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const [{ items }, prefs] = await Promise.all([listNotifications(ctx, { take: 200 }), listPreferences(ctx)]);
  return <NotificationsView orgSlug={org} items={items} prefs={prefs} types={EXTERNAL_NOTIFICATION_TYPES} base="portal" />;
}

export default guardPage(NotificationsPage);
