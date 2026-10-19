import { PageBody } from "@/components/app/page";
import { NotificationsView } from "@/components/notifications/notifications-view";
import { listNotifications, listPreferences } from "@/server/modules/notifications/service";
import { STAFF_NOTIFICATION_TYPES } from "@/server/modules/notifications/types";
import { requirePageContext } from "@/server/request";

export default async function NotificationsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const [{ items }, prefs] = await Promise.all([listNotifications(ctx, { take: 200 }), listPreferences(ctx)]);
  return <PageBody><NotificationsView orgSlug={org} items={items} prefs={prefs} types={STAFF_NOTIFICATION_TYPES} base="o" /></PageBody>;
}
