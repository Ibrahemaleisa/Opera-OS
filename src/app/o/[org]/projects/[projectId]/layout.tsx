import { notFound } from "next/navigation";
import { PageBody } from "@/components/app/page";
import { Breadcrumbs } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { TabNav } from "@/components/app/tab-nav";
import { getI18n } from "@/lib/i18n/server";
import { NotFoundError } from "@/server/errors";
import { getProjectHeader } from "@/server/modules/projects/service";
import { requirePageContext } from "@/server/request";
import { can } from "@/server/authz/policy";

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const { m, dir } = await getI18n();
  const header = await getProjectHeader(ctx, projectId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const b = `/o/${org}/projects/${projectId}`;
  const has = (k: string) => header.kinds.includes(k as never);
  const p = m.projects;
  const tabs = [
    { href: b, label: p.overview, exact: true },
    { href: `${b}/tasks`, label: p.tasks },
    { href: `${b}/workstreams`, label: p.workstreams },
    ...(has("VIP_DELIVERY") ? [{ href: `${b}/delivery`, label: m.nav.delivery }] : []),
    ...(has("DIGITAL_INVITES") ? [{ href: `${b}/digital`, label: m.nav.digital }] : []),
    ...(has("EVENT_OPS") || has("CONFERENCE") ? [{ href: `${b}/events`, label: m.nav.events }] : []),
    ...(has("PROTOCOL") ? [{ href: `${b}/protocol`, label: m.nav.protocol }] : []),
    ...(has("BOOTH") || has("PAVILION") ? [{ href: `${b}/production`, label: m.nav.booths }] : []),
    ...(can(ctx, "vendor.view") && !header.scope.clientView && !header.scope.fieldOnly ? [{ href: `${b}/procurement`, label: m.vendors.procurement }] : []),
    ...(header.scope.finance ? [{ href: `${b}/finance`, label: m.nav.finance }] : []),
    { href: `${b}/approvals`, label: p.approvals },
    { href: `${b}/team`, label: p.members },
    { href: `${b}/activity`, label: p.activity },
  ];
  return (
    <PageBody className="pt-4">
      <Breadcrumbs dir={dir} items={[{ label: m.projects.title, href: `/o/${org}/projects` }, { label: header.code }]} />
      <div className="mt-2 mb-3 flex flex-wrap items-center gap-2">
        <h1 className="page-title">{header.name}</h1>
        <StatusBadge status={header.status} label={m.enums.projectStatus[header.status]} />
        <span className="text-xs text-muted-foreground">{m.enums.projectType[header.type as keyof typeof m.enums.projectType] ?? header.type}</span>
      </div>
      <TabNav items={tabs} className="mb-5" />
      {children}
    </PageBody>
  );
}
