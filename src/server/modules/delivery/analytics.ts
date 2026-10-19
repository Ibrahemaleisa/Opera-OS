import type { ServiceContext } from "@/server/authz/context";
import { assertCan, projectScope } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";
import { NotFoundError } from "@/server/errors";

/** Campaign delivery KPIs computed from live delivery/attempt records. */
export async function campaignKpis(ctx: ServiceContext, campaignId: string) {
  assertCan(ctx, "delivery.view");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const c = await tx.invitationCampaign.findUnique({ where: { id: campaignId } });
    if (!c) throw new NotFoundError();
    const scope = await projectScope(tx, ctx, c.projectId);
    if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
    const [byStatus, firstAttempt, deliveredCount, byAgent, byCity, onTime, attemptsByReason, avgAttempts] = await Promise.all([
      tx.delivery.groupBy({ by: ["status"], where: { campaignId }, _count: true }),
      tx.deliveryAttempt.count({ where: { delivery: { campaignId }, attemptNo: 1, outcome: "DELIVERED" } }),
      tx.delivery.count({ where: { campaignId, status: "DELIVERED" } }),
      tx.delivery.groupBy({ by: ["agentId", "status"], where: { campaignId, agentId: { not: null } }, _count: true }),
      tx.$queryRaw<{ city: string | null; district: string | null; total: bigint; delivered: bigint }[]>`
        SELECT r.city, r.district, count(*)::bigint AS total, count(*) FILTER (WHERE d.status = 'DELIVERED')::bigint AS delivered
        FROM "Delivery" d JOIN "Recipient" r ON r.id = d."recipientId"
        WHERE d."campaignId" = ${campaignId} AND d.status <> 'CANCELLED'
        GROUP BY r.city, r.district ORDER BY total DESC LIMIT 50`,
      c.deliveryDeadline ? tx.delivery.count({ where: { campaignId, status: "DELIVERED", deliveredAt: { lte: c.deliveryDeadline } } }) : Promise.resolve(null),
      tx.deliveryAttempt.groupBy({ by: ["failureReason"], where: { delivery: { campaignId }, outcome: { in: ["FAILED", "RETURNED"] } }, _count: true }),
      tx.delivery.aggregate({ where: { campaignId, status: "DELIVERED" }, _avg: { attemptsCount: true } }),
    ]);
    const total = byStatus.filter((s) => s.status !== "CANCELLED").reduce((n, s) => n + s._count, 0);
    const count = (st: string) => byStatus.find((s) => s.status === st)?._count ?? 0;
    const agentIds = [...new Set(byAgent.map((a) => a.agentId!))];
    const agents = await tx.user.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true, nameAr: true } });
    const attempts = await tx.deliveryAttempt.groupBy({ by: ["agentId", "outcome"], where: { delivery: { campaignId } }, _count: true });
    return {
      campaign: { id: c.id, name: c.name, deadline: c.deliveryDeadline, status: c.status },
      total,
      delivered: count("DELIVERED"),
      pending: count("PENDING") + count("VALIDATING") + count("READY"),
      inProgress: count("ASSIGNED") + count("OUT_FOR_DELIVERY"),
      failed: count("FAILED_ATTEMPT"),
      rescheduled: count("RESCHEDULED"),
      returned: count("RETURNED"),
      cancelled: count("CANCELLED"),
      completion: total ? count("DELIVERED") / total : null,
      firstAttemptSuccess: deliveredCount ? firstAttempt / deliveredCount : null,
      avgAttempts: avgAttempts._avg.attemptsCount,
      slaCompliance: onTime === null || !deliveredCount ? null : onTime / deliveredCount,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
      failureReasons: attemptsByReason.map((r) => ({ reason: r.failureReason ?? "OTHER", count: r._count })),
      agents: agentIds.map((id) => {
        const u = agents.find((a) => a.id === id);
        const rows = byAgent.filter((a) => a.agentId === id);
        const at = attempts.filter((a) => a.agentId === id);
        const tot = rows.reduce((n, r) => n + r._count, 0);
        const dl = rows.find((r) => r.status === "DELIVERED")?._count ?? 0;
        const atTotal = at.reduce((n, a) => n + a._count, 0);
        return { id, name: (ctx.locale === "ar" ? u?.nameAr : null) ?? u?.name ?? "—", assigned: tot, delivered: dl, failed: at.filter((a) => a.outcome !== "DELIVERED").reduce((n, a) => n + a._count, 0), attempts: atTotal, successRate: atTotal ? (at.find((a) => a.outcome === "DELIVERED")?._count ?? 0) / atTotal : null };
      }).sort((a, b) => b.delivered - a.delivered),
      geography: byCity.map((g) => ({ city: g.city ?? "—", district: g.district ?? "—", total: Number(g.total), delivered: Number(g.delivered) })),
    };
  });
}

export async function listCampaigns(ctx: ServiceContext, projectId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
    const campaigns = await tx.invitationCampaign.findMany({ where: { projectId, type: "PHYSICAL" }, orderBy: { createdAt: "asc" } });
    const counts = await tx.delivery.groupBy({ by: ["campaignId", "status"], where: { projectId }, _count: true });
    return campaigns.map((c) => {
      const rows = counts.filter((x) => x.campaignId === c.id);
      const total = rows.filter((r) => r.status !== "CANCELLED").reduce((n, r) => n + r._count, 0);
      const delivered = rows.find((r) => r.status === "DELIVERED")?._count ?? 0;
      return { ...c, total, delivered, failed: rows.find((r) => r.status === "FAILED_ATTEMPT")?._count ?? 0 };
    });
  });
}

/** Org-wide view of all physical campaigns the caller can see. */
export async function orgDeliveryOverview(ctx: ServiceContext) {
  assertCan(ctx, "delivery.view");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { projectVisibilityWhere } = await import("@/server/authz/policy");
    const projects = await tx.project.findMany({ where: projectVisibilityWhere(ctx), select: { id: true, code: true, name: true } });
    const campaigns = await tx.invitationCampaign.findMany({ where: { projectId: { in: projects.map((p) => p.id) }, type: "PHYSICAL" }, orderBy: { createdAt: "desc" } });
    const counts = await tx.delivery.groupBy({ by: ["campaignId", "status"], where: { campaignId: { in: campaigns.map((c) => c.id) } }, _count: true });
    return campaigns.map((c) => {
      const rows = counts.filter((x) => x.campaignId === c.id);
      const total = rows.filter((r) => r.status !== "CANCELLED").reduce((n, r) => n + r._count, 0);
      const by = (s: string) => rows.find((r) => r.status === s)?._count ?? 0;
      return { id: c.id, name: c.name, status: c.status, deadline: c.deliveryDeadline, project: projects.find((p) => p.id === c.projectId)!, total, delivered: by("DELIVERED"), failed: by("FAILED_ATTEMPT"), inField: by("ASSIGNED") + by("OUT_FOR_DELIVERY"), unassigned: by("READY") + by("PENDING") + by("VALIDATING") };
    });
  });
}
