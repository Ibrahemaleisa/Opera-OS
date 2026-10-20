import { PageBody, PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan } from "@/server/authz/policy";
import { getTemplate } from "@/server/modules/templates/service";
import { requirePageContext } from "@/server/request";
import { TemplateBuilder } from "./builder";
import { guardPage } from "@/server/page-guard";

async function TemplatePage({ params }: { params: Promise<{ org: string; templateId: string }> }) {
  const { org, templateId } = await params;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "template.manage");
  const { m, locale, dir } = await getI18n();
  const t = await getTemplate(ctx, templateId);
  return (
    <PageBody>
      <PageHeader title={locale === "ar" ? t.nameAr : t.nameEn} description={(locale === "ar" ? t.descriptionAr : t.descriptionEn) ?? undefined} crumbs={[{ label: m.templates.title, href: `/o/${org}/templates` }, { label: t.key }]} dir={dir} />
      <TemplateBuilder
        orgSlug={org}
        templateId={t.id}
        versions={t.versions.map((v) => ({ id: v.id, version: v.version, changelog: v.changelog, createdAt: v.createdAt.toISOString(), definition: v.definition }))}
        usage={t.usage.map((u) => ({ version: u.versionNumber, count: u._count }))}
      />
    </PageBody>
  );
}

export default guardPage(TemplatePage);
