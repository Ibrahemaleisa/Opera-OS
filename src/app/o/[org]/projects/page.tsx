import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageBody, PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { can } from "@/server/authz/policy";
import { listProjects } from "@/server/modules/projects/service";
import { requirePageContext } from "@/server/request";
import { PortfolioViews } from "./portfolio-views";
import { guardPage } from "@/server/page-guard";

export const metadata = { title: "Projects" };

async function ProjectsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ view?: string; status?: string; q?: string; closed?: string }> }) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await requirePageContext(org);
  const { m } = await getI18n();
  const projects = await listProjects(ctx, { status: sp.status, q: sp.q, includeClosed: sp.closed === "1" });
  return (
    <PageBody>
      <PageHeader
        title={m.projects.portfolio}
        description={m.projects.portfolioDesc}
        actions={can(ctx, "project.create") && (
          <Button asChild size="sm"><Link href={`/o/${org}/projects/new`}><Plus /> {m.projects.newProject}</Link></Button>
        )}
      />
      <PortfolioViews orgSlug={org} projects={JSON.parse(JSON.stringify(projects))} view={sp.view ?? "list"} canCreate={can(ctx, "project.create")} />
    </PageBody>
  );
}

export default guardPage(ProjectsPage);
