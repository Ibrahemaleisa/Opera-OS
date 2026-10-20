import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { interpolate } from "@/lib/i18n";
import { assertCan } from "@/server/authz/policy";
import { listTemplates } from "@/server/modules/templates/service";
import { requirePageContext } from "@/server/request";
import { NewTemplateButton } from "./new-template";
import { guardPage } from "@/server/page-guard";

async function TemplatesPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "template.manage");
  const { m, locale } = await getI18n();
  const templates = await listTemplates(ctx);
  const cats = [...new Set(templates.map((t) => t.category))];
  return (
    <PageBody>
      <PageHeader title={m.templates.title} description={m.templates.desc} actions={<NewTemplateButton orgSlug={org} templates={templates.map((t) => ({ id: t.id, name: locale === "ar" ? t.nameAr : t.nameEn }))} />} />
      <div className="grid gap-6">
        {cats.map((c) => (
          <div key={c}>
            <h2 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">{m.templates.categories[c as keyof typeof m.templates.categories] ?? c}</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {templates.filter((t) => t.category === c).map((t) => (
                <Link key={t.id} href={`/o/${org}/templates/${t.id}`} className="surface flex flex-col gap-1 p-4 transition-colors hover:border-primary/50">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>{t.isSystem ? m.templates.system : m.templates.custom}</span><span>v{t.latestVersion}</span></div>
                  <div className="font-medium">{locale === "ar" ? t.nameAr : t.nameEn}</div>
                  <p className="text-xs text-muted-foreground">{locale === "ar" ? t.descriptionAr : t.descriptionEn}</p>
                  {t.stats && <div className="tabular mt-auto pt-2 text-[11px] text-muted-foreground">{interpolate(m.templates.workstreamsCount, { n: t.stats.workstreams })} · {interpolate(m.templates.tasksCount, { n: t.stats.tasks })} · {t.stats.milestones} {m.projects.milestones}</div>}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </PageBody>
  );
}

export default guardPage(TemplatesPage);
