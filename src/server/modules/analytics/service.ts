import type { ServiceContext } from "@/server/authz/context";
import { can, projectVisibilityWhere } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";

const DAY = 86400_000;

/**
 * Organization dashboard KPIs. Every number is computed from current records within the
 * caller's visible projects; finance figures only when the caller holds finance.view.
 */
export async function orgDashboard(ctx: ServiceContext, now = new Date()) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const visible = await tx.project.findMany({ where: projectVisibilityWhere(ctx), select: { id: true, status: true } });
    const ids = visible.map((p) => p.id);
    const active = visible.filter((p) => ["PLANNING", "ACTIVE", "AT_RISK", "ON_HOLD"].includes(p.status));
    const since = new Date(now.getTime() - 90 * DAY);
    const [overdue, completed, completedOnTime, openTasks, pendingApprovals, clientPending, highRisks, escalations, upcomingEvents, workload, deliveryByStatus, rsvpByResponse, invitationsSent, boothsByStage, openIncidents] = await Promise.all([
      tx.task.count({ where: { projectId: { in: ids }, statusCategory: { notIn: ["DONE", "CANCELLED"] }, dueAt: { lt: now } } }),
      tx.task.count({ where: { projectId: { in: ids }, statusCategory: "DONE", completedAt: { gte: since }, dueAt: { not: null } } }),
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "Task" WHERE "projectId" = ANY(${ids}) AND "statusCategory" = 'DONE' AND "completedAt" >= ${since} AND "dueAt" IS NOT NULL AND "completedAt" <= "dueAt"`,
      tx.task.count({ where: { projectId: { in: ids }, statusCategory: { notIn: ["DONE", "CANCELLED"] } } }),
      tx.approval.count({ where: { projectId: { in: ids }, status: "PENDING" } }),
      tx.approval.count({ where: { projectId: { in: ids }, status: "PENDING", approverType: "CLIENT" } }),
      tx.risk.count({ where: { projectId: { in: ids }, status: { not: "CLOSED" }, likelihood: { gte: 3 }, impact: { gte: 3 } } }),
      tx.task.count({ where: { projectId: { in: ids }, escalatedAt: { not: null }, statusCategory: { notIn: ["DONE", "CANCELLED"] } } }),
      tx.event.findMany({ where: { projectId: { in: ids }, startsAt: { gte: now, lte: new Date(now.getTime() + 30 * DAY) } }, orderBy: { startsAt: "asc" }, take: 8, select: { id: true, name: true, startsAt: true, phase: true, projectId: true } }),
      tx.task.groupBy({ by: ["ownerId"], where: { projectId: { in: ids }, statusCategory: { notIn: ["DONE", "CANCELLED"] }, ownerId: { not: null } }, _count: true, orderBy: { _count: { ownerId: "desc" } }, take: 8 }),
      tx.delivery.groupBy({ by: ["status"], where: { projectId: { in: ids } }, _count: true }),
      tx.digitalInvitation.groupBy({ by: ["rsvpStatus"], where: { projectId: { in: ids } }, _count: true }),
      tx.digitalInvitation.count({ where: { projectId: { in: ids }, status: { in: ["SENT", "DELIVERED", "READ"] } } }),
      tx.booth.groupBy({ by: ["stage"], where: { projectId: { in: ids } }, _count: true }),
      tx.incident.count({ where: { projectId: { in: ids }, status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] } } }),
    ]);
    const owners = await tx.user.findMany({ where: { id: { in: workload.map((w) => w.ownerId!).filter(Boolean) } }, select: { id: true, name: true, nameAr: true } });
    const deliveryTotal = deliveryByStatus.filter((d) => d.status !== "CANCELLED").reduce((n, d) => n + d._count, 0);
    const delivered = deliveryByStatus.find((d) => d.status === "DELIVERED")?._count ?? 0;
    const invitations = rsvpByResponse.reduce((n, r) => n + r._count, 0);
    const responded = rsvpByResponse.filter((r) => r.rsvpStatus).reduce((n, r) => n + r._count, 0);
    const attending = rsvpByResponse.find((r) => r.rsvpStatus === "ATTENDING")?._count ?? 0;

    let finance: { planned: number; committed: number; actual: number } | null = null;
    if (can(ctx, "finance.view")) {
      const [b, po, ex] = await Promise.all([
        tx.budget.aggregate({ where: { projectId: { in: ids } }, _sum: { planned: true } }),
        tx.purchaseOrder.aggregate({ where: { projectId: { in: ids }, status: { in: ["APPROVED", "ISSUED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED"] } }, _sum: { amount: true } }),
        tx.expense.aggregate({ where: { projectId: { in: ids }, status: { in: ["APPROVED", "PAID"] } }, _sum: { amount: true } }),
      ]);
      finance = { planned: Number(b._sum.planned ?? 0), committed: Number(po._sum.amount ?? 0), actual: Number(ex._sum.amount ?? 0) };
    }
    return {
      projects: { visible: visible.length, active: active.length, atRisk: visible.filter((p) => p.status === "AT_RISK").length, byStatus: Object.entries(visible.reduce<Record<string, number>>((a, p) => ((a[p.status] = (a[p.status] ?? 0) + 1), a), {})).map(([status, count]) => ({ status, count })) },
      tasks: { open: openTasks, overdue, completed90: completed, onTimeRate: completed ? Number(completedOnTime[0]?.n ?? 0) / completed : null, escalations },
      approvals: { pending: pendingApprovals, clientPending },
      risks: { high: highRisks },
      incidents: { open: openIncidents },
      upcomingEvents,
      workload: workload.map((w) => ({ userId: w.ownerId!, name: (() => { const u = owners.find((o) => o.id === w.ownerId); return u ? (ctx.locale === "ar" ? u.nameAr : null) ?? u.name : "—"; })(), open: w._count })),
      delivery: { total: deliveryTotal, delivered, completion: deliveryTotal ? delivered / deliveryTotal : null, byStatus: deliveryByStatus.map((d) => ({ status: d.status, count: d._count })) },
      invitations: { total: invitations, sent: invitationsSent, responded, attending, rsvpRate: invitationsSent ? responded / invitationsSent : null },
      booths: boothsByStage.map((b) => ({ stage: b.stage, count: b._count })),
      finance,
    };
  });
}
