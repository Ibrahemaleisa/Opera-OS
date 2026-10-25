import { PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan, can } from "@/server/authz/policy";
import { listProviders } from "@/server/modules/digital/service";
import { providerStatus } from "@/server/modules/digital/providers";
import { requirePageContext } from "@/server/request";
import { ProvidersClient } from "./providers-client";
import { DeliveryLog } from "./delivery-log";
import { listDeliveries } from "@/server/modules/notifications/delivery";
import { typeDef } from "@/server/modules/notifications/types";
import { guardPage } from "@/server/page-guard";

async function ProvidersPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ status?: string }> }) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "campaign.manage");
  const { m } = await getI18n();
  const { rows, suppressions } = await listProviders(ctx);
  const env = providerStatus();
  const channels = (["EMAIL", "SMS", "WHATSAPP"] as const).map((channel) => {
    const r = rows.find((x) => x.channel === channel);
    return { channel, mode: r?.mode === "LIVE" && env[channel] ? "LIVE" : "SIMULATION", liveProvider: env[channel], senderId: r?.senderId ?? null };
  });
  // the delivery log is an admin view (owners and directors): who was e-mailed, and whether it left
  const status = sp.status === "attention" ? "attention" : "all";
  const log = can(ctx, "org.manage") ? await listDeliveries(ctx, { status: status === "all" ? null : status, take: 50 }) : null;
  return (
    <>
      <PageHeader title={m.digital.providers} description={m.digital.simulationBanner} />
      <div className="grid gap-6">
        <ProvidersClient orgSlug={org} channels={channels} suppressions={suppressions} canManage={can(ctx, "org.manage")} />
        {log && (
          <DeliveryLog
            orgSlug={org}
            rows={log.rows.map((r) => ({ ...r, typeKey: typeDef(r.type).key }))}
            counts={log.counts}
            mode={log.mode}
            status={status}
          />
        )}
      </div>
    </>
  );
}

export default guardPage(ProvidersPage);
