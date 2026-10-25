import { PageBody } from "@/components/app/page";
import { NotificationsView } from "@/components/notifications/notifications-view";
import { emailChannelState, listNotifications, listPreferences } from "@/server/modules/notifications/service";
import { STAFF_NOTIFICATION_TYPES } from "@/server/modules/notifications/types";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

async function NotificationsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const [{ items }, prefs, channel] = await Promise.all([listNotifications(ctx, { take: 200 }), listPreferences(ctx), emailChannelState(ctx)]);
  return <PageBody><NotificationsView orgSlug={org} items={items} prefs={prefs} types={STAFF_NOTIFICATION_TYPES} base="o" emailSimulated={channel.simulated} /></PageBody>;
}

export default guardPage(NotificationsPage);
