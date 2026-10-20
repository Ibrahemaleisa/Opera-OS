import { PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan, can } from "@/server/authz/policy";
import { listProviders } from "@/server/modules/digital/service";
import { providerStatus } from "@/server/modules/digital/providers";
import { requirePageContext } from "@/server/request";
import { ProvidersClient } from "./providers-client";
import { guardPage } from "@/server/page-guard";

async function ProvidersPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "campaign.manage");
  const { m } = await getI18n();
  const { rows, suppressions } = await listProviders(ctx);
  const env = providerStatus();
  const channels = (["EMAIL", "SMS", "WHATSAPP"] as const).map((channel) => {
    const r = rows.find((x) => x.channel === channel);
    return { channel, mode: r?.mode === "LIVE" && env[channel] ? "LIVE" : "SIMULATION", liveProvider: env[channel], senderId: r?.senderId ?? null };
  });
  return (
    <>
      <PageHeader title={m.digital.providers} description={m.digital.simulationBanner} />
      <ProvidersClient orgSlug={org} channels={channels} suppressions={suppressions} canManage={can(ctx, "org.manage")} />
    </>
  );
}

export default guardPage(ProvidersPage);
