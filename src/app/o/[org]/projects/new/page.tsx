import { PageBody, PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan } from "@/server/authz/policy";
import { listClients, listVenues, memberDirectory } from "@/server/modules/org/service";
import { listTemplates } from "@/server/modules/templates/service";
import { requirePageContext } from "@/server/request";
import { ProjectWizard } from "./wizard";

export default async function NewProjectPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "project.create");
  const { m, locale } = await getI18n();
  const [clients, venues, templates, people] = await Promise.all([listClients(ctx), listVenues(ctx), listTemplates(ctx), memberDirectory(ctx, { baseRoles: ["OWNER", "OPS_DIRECTOR", "PROJECT_MANAGER", "TEAM_LEAD"] })]);
  return (
    <PageBody className="max-w-5xl">
      <PageHeader title={m.projects.wizard.title} crumbs={[{ label: m.projects.title, href: `/o/${org}/projects` }, { label: m.projects.newProject }]} dir={locale === "ar" ? "rtl" : "ltr"} />
      <ProjectWizard
        orgSlug={org}
        clients={clients.map((c) => ({ id: c.id, name: c.name }))}
        venues={venues.map((v) => ({ id: v.id, name: v.name, city: v.city }))}
        managers={people}
        currentUserId={ctx.userId}
        templates={templates.map((t) => ({ id: t.id, key: t.key, name: locale === "ar" ? t.nameAr : t.nameEn, description: (locale === "ar" ? t.descriptionAr : t.descriptionEn) ?? "", category: t.category, isSystem: t.isSystem, latestVersion: t.latestVersion, stats: t.stats }))}
      />
    </PageBody>
  );
}
