import { PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { listAutomation } from "@/server/modules/automation/admin";
import { requirePageContext } from "@/server/request";
import { AutomationRules } from "./rules";
import { guardPage } from "@/server/page-guard";

async function AutomationPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m } = await getI18n();
  const data = await listAutomation(ctx);
  return (
    <>
      <PageHeader title={m.org.automation.title} description={m.org.automation.desc} />
      <AutomationRules orgSlug={org} data={data} />
    </>
  );
}

export default guardPage(AutomationPage);
