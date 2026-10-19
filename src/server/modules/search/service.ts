import type { ServiceContext } from "@/server/authz/context";
import { can, projectVisibilityWhere } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";

export interface SearchHit {
  kind: "project" | "task" | "recipient" | "delivery" | "vendor" | "client";
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

/** Permission-aware global search. Recipient hits never include contact data. */
export async function globalSearch(ctx: ServiceContext, q: string): Promise<SearchHit[]> {
  const term = q.trim();
  const ci = { contains: term, mode: "insensitive" as const };
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const projectWhere = projectVisibilityWhere(ctx);
    const visibleProjects = await tx.project.findMany({ where: projectWhere, select: { id: true } });
    const projectIds = visibleProjects.map((p) => p.id);
    const hits: SearchHit[] = [];
    const projects = await tx.project.findMany({ where: { ...projectWhere, OR: [{ name: ci }, { nameEn: ci }, { code: ci }, { contractRef: ci }] }, take: 6 });
    hits.push(...projects.map((p) => ({ kind: "project" as const, id: p.id, title: p.name, subtitle: p.code, href: `/projects/${p.id}` })));
    const num = Number(term.replace(/^.*-/, ""));
    const tasks = await tx.task.findMany({
      where: {
        projectId: { in: projectIds },
        OR: [{ title: ci }, ...(Number.isInteger(num) && num > 0 ? [{ number: num }] : [])],
        ...(ctx.role === "FREELANCER" ? { OR: [{ ownerId: ctx.userId }, { collaborators: { some: { userId: ctx.userId } } }] } : {}),
      },
      include: { project: { select: { code: true } } },
      take: 8,
    });
    hits.push(...tasks.map((t) => ({ kind: "task" as const, id: t.id, title: t.title, subtitle: `${t.project.code}-${t.number}`, href: `/tasks/${t.id}` })));
    if (can(ctx, "recipient.view")) {
      const recipients = await tx.recipient.findMany({
        where: { projectId: { in: projectIds }, deletedAt: null, OR: [{ nameAr: ci }, { nameEn: ci }, { code: ci }, { organizationName: ci }] },
        select: { id: true, nameAr: true, nameEn: true, code: true, projectId: true, organizationName: true },
        take: 6,
      });
      hits.push(...recipients.map((r) => ({ kind: "recipient" as const, id: r.id, title: (ctx.locale === "ar" ? r.nameAr : r.nameEn) ?? r.nameAr ?? r.nameEn ?? r.code, subtitle: `${r.code}${r.organizationName ? " · " + r.organizationName : ""}`, href: `/projects/${r.projectId}/delivery/recipients?focus=${r.id}` })));
    }
    if (can(ctx, "delivery.view")) {
      const deliveries = await tx.delivery.findMany({ where: { projectId: { in: projectIds }, trackingCode: ci }, select: { id: true, trackingCode: true, projectId: true, status: true }, take: 5 });
      hits.push(...deliveries.map((d) => ({ kind: "delivery" as const, id: d.id, title: d.trackingCode, subtitle: d.status, href: `/projects/${d.projectId}/delivery/cards/${d.id}` })));
    }
    if (can(ctx, "vendor.view")) {
      const vendors = await tx.vendor.findMany({ where: { OR: [{ name: ci }, { nameEn: ci }] }, take: 4 });
      hits.push(...vendors.map((v) => ({ kind: "vendor" as const, id: v.id, title: v.name, subtitle: v.category, href: `/vendors/${v.id}` })));
    }
    if (can(ctx, "org.directory.manage")) {
      const clients = await tx.client.findMany({ where: { OR: [{ name: ci }, { nameEn: ci }] }, take: 4 });
      hits.push(...clients.map((c) => ({ kind: "client" as const, id: c.id, title: c.name, subtitle: c.sector ?? undefined, href: `/settings/clients` })));
    }
    return hits;
  });
}
