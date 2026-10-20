import { PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan } from "@/server/authz/policy";
import { getOrganization, readSettings } from "@/server/modules/org/service";
import { requirePageContext } from "@/server/request";
import { OrgSettingsForm } from "./settings-form";
import { guardPage } from "@/server/page-guard";

async function SettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await requirePageContext(slug);
  assertCan(ctx, "org.manage");
  const { m } = await getI18n();
  const org = await getOrganization(ctx);
  const s = readSettings(org.settings);
  return (
    <>
      <PageHeader title={m.org.settingsTitle} description={m.org.settingsDesc} />
      <OrgSettingsForm
        orgSlug={slug}
        initial={{
          name: org.name, nameEn: org.nameEn ?? "", legalName: org.legalName ?? "", crNumber: org.crNumber ?? "", vatNumber: org.vatNumber ?? "",
          email: org.email ?? "", phone: org.phone ?? "", city: org.city ?? "", brandColor: org.brandColor, defaultLocale: org.defaultLocale as "ar" | "en",
          calendar: org.calendar as "gregory" | "islamic-umalqura", financeApprovalThreshold: s.financeApprovalThreshold, recipientRetentionDays: s.recipientRetentionDays,
        }}
      />
    </>
  );
}

export default guardPage(SettingsPage);
