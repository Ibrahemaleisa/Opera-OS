import type { ServiceContext } from "@/server/authz/context";
import { assertCan, can, projectVisibilityWhere } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";
import { ForbiddenError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { financeOverview } from "@/server/modules/finance/service";
import { listVendors } from "@/server/modules/vendors/service";

export const REPORT_KINDS = ["projects", "tasks", "incidents", "vendors", "finance"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Which reports the caller may export. All exports also require export.data. */
export function availableReports(ctx: ServiceContext): ReportKind[] {
  if (!can(ctx, "report.view") || !can(ctx, "export.data")) return [];
  return REPORT_KINDS.filter((k) => (k === "finance" ? can(ctx, "finance.view") : k === "vendors" ? can(ctx, "vendor.view") : true));
}

/** Builds report rows from live records. Never includes recipient/guest personal data. */
export async function buildReport(ctx: ServiceContext, kind: ReportKind, now = new Date()): Promise<{ headers: string[]; rows: unknown[][] }> {
  assertCan(ctx, "report.view");
  assertCan(ctx, "export.data");
  if (!availableReports(ctx).includes(kind)) throw new ForbiddenError();
  const out = await (async () => {
    if (kind === "finance") {
      const f = await financeOverview(ctx);
      return { headers: ["code", "project", "contract_revised", "planned", "committed", "actual", "forecast", "margin", "margin_pct"], rows: f.projects.map((p) => [p.code, p.name, p.contract.revised, p.totals.planned, p.totals.committed, p.totals.actual, p.totals.forecast, p.margin?.amount ?? "", p.margin?.ratio != null ? Math.round(p.margin.ratio * 1000) / 10 : ""]) };
    }
    if (kind === "vendors") {
      const v = await listVendors(ctx);
      return { headers: ["vendor", "category", "status", "work_orders", "completed", "avg_rating", "on_time_pct", "quotes", "win_rate_pct"], rows: v.vendors.map((x) => [x.name, x.category, x.status, x.perf.workOrders, x.perf.completed, x.perf.avgRating?.toFixed(2) ?? "", x.perf.onTimeRate != null ? Math.round(x.perf.onTimeRate * 100) : "", x.perf.quotes, x.perf.winRate != null ? Math.round(x.perf.winRate * 100) : ""]) };
    }
    return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
      const projects = await tx.project.findMany({ where: { ...projectVisibilityWhere(ctx), archivedAt: null }, orderBy: { createdAt: "desc" } });
      const pmap = new Map(projects.map((p) => [p.id, p]));
      const ids = projects.map((p) => p.id);
      if (kind === "projects") {
        const tasks = await tx.task.groupBy({ by: ["projectId", "statusCategory"], where: { projectId: { in: ids } }, _count: true });
        const overdue = await tx.task.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, statusCategory: { not: "DONE" }, dueAt: { lt: now } }, _count: true });
        return {
          headers: ["code", "name", "type", "status", "priority", "event_start", "deadline", "tasks_total", "tasks_done", "tasks_blocked", "tasks_overdue"],
          rows: projects.map((p) => {
            const t = tasks.filter((x) => x.projectId === p.id);
            const n = (c: string) => t.filter((x) => x.statusCategory === c).reduce((a, x) => a + x._count, 0);
            return [p.code, p.name, p.type, p.status, p.priority, p.eventStartAt, p.deadline, t.reduce((a, x) => a + x._count, 0), n("DONE"), n("BLOCKED"), overdue.find((o) => o.projectId === p.id)?._count ?? 0];
          }),
        };
      }
      if (kind === "tasks") {
        const tasks = await tx.task.findMany({ where: { projectId: { in: ids }, statusCategory: { not: "DONE" } }, orderBy: [{ dueAt: "asc" }], take: 20000, include: { owner: { select: { name: true } } } });
        return { headers: ["project", "number", "title", "status", "priority", "owner", "due", "overdue"], rows: tasks.map((t) => [pmap.get(t.projectId)?.code, t.number, t.title, t.status, t.priority, t.owner?.name ?? "", t.dueAt, t.dueAt && t.dueAt < now ? "yes" : ""]) };
      }
      const incidents = await tx.incident.findMany({ where: { projectId: { in: ids } }, orderBy: { createdAt: "desc" }, take: 20000 });
      return { headers: ["project", "title", "severity", "status", "escalation", "location", "reported_at", "resolved_at", "minutes_to_resolve", "resolution"], rows: incidents.map((i) => [pmap.get(i.projectId)?.code, i.title, i.severity, i.status, i.escalationLevel, i.location, i.createdAt, i.resolvedAt, i.resolvedAt ? Math.round((i.resolvedAt.getTime() - i.createdAt.getTime()) / 60000) : "", i.resolution]) };
    });
  })();
  await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => audit(tx, ctx, { action: "report.export", entityType: "REPORT", summary: `${kind} (${out.rows.length})` }));
  return out;
}

