import { z } from "zod";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan, can } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";
import { NotFoundError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";

export const profileSchema = z.object({
  userId: z.string(),
  kind: z.enum(["EMPLOYEE", "FREELANCER", "DRIVER"]),
  dailyCapacity: z.coerce.number().int().min(0).max(500),
  skills: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
  territories: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  vehicle: z.string().trim().max(100).nullish(),
  active: z.boolean().default(true),
});

const ACTIVE_DELIVERY = ["ASSIGNED", "OUT_FOR_DELIVERY", "RESCHEDULED"] as const;

/**
 * Capacity and load for the next 7 days, computed from real assignments:
 * staff → scheduled shift hours + estimated open-task hours vs. daily capacity × 5 working days;
 * drivers → active deliveries vs. daily delivery capacity.
 */
export async function resourceBoard(ctx: ServiceContext, now = new Date()) {
  assertCan(ctx, "org.members.view");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const horizon = new Date(now.getTime() + 7 * 86400_000);
    const members = await tx.membership.findMany({ where: { status: "ACTIVE", role: { baseRole: { notIn: ["CLIENT", "CLIENT_APPROVER", "VENDOR"] } } }, include: { user: { select: { id: true, name: true, nameAr: true } }, role: { select: { nameAr: true, nameEn: true, baseRole: true } } } });
    const ids = members.map((m) => m.userId);
    const [profiles, tasks, shifts, deliveries] = await Promise.all([
      tx.resourceProfile.findMany({ where: { userId: { in: ids } } }),
      tx.task.findMany({ where: { ownerId: { in: ids }, statusCategory: { notIn: ["DONE"] } }, select: { ownerId: true, dueAt: true, estimateMinutes: true, statusCategory: true } }),
      tx.shift.findMany({ where: { userId: { in: ids }, startsAt: { lt: horizon }, endsAt: { gt: now } }, select: { userId: true, startsAt: true, endsAt: true } }),
      tx.delivery.groupBy({ by: ["agentId"], where: { agentId: { in: ids }, status: { in: [...ACTIVE_DELIVERY] } }, _count: true }),
    ]);
    const rows = members.map((m) => {
      const p = profiles.find((x) => x.userId === m.userId);
      const kind = p?.kind ?? (m.role.baseRole === "FIELD_AGENT" ? "DRIVER" : "EMPLOYEE");
      const capacity = p?.dailyCapacity ?? (kind === "DRIVER" ? 25 : 8);
      const myTasks = tasks.filter((t) => t.ownerId === m.userId);
      const due7 = myTasks.filter((t) => t.dueAt && t.dueAt <= horizon);
      const overdue = myTasks.filter((t) => t.dueAt && t.dueAt < now).length;
      const shiftHours = shifts.filter((s) => s.userId === m.userId).reduce((a, s) => a + (Math.min(s.endsAt.getTime(), horizon.getTime()) - Math.max(s.startsAt.getTime(), now.getTime())) / 3600_000, 0);
      const taskHours = due7.reduce((a, t) => a + (t.estimateMinutes ?? 60) / 60, 0);
      const activeDeliveries = deliveries.find((d) => d.agentId === m.userId)?._count ?? 0;
      const load = kind === "DRIVER" ? (capacity ? activeDeliveries / capacity : null) : capacity ? (shiftHours + taskHours) / (capacity * 5) : null;
      return {
        userId: m.userId,
        name: (ctx.locale === "ar" ? m.user.nameAr : null) ?? m.user.name,
        role: ctx.locale === "ar" ? m.role.nameAr : m.role.nameEn,
        kind,
        capacity,
        skills: p?.skills ?? [],
        territories: p?.territories ?? [],
        vehicle: p?.vehicle ?? null,
        active: p?.active ?? true,
        openTasks: myTasks.length,
        dueThisWeek: due7.length,
        overdue,
        shiftHours: Math.round(shiftHours * 10) / 10,
        taskHours: Math.round(taskHours * 10) / 10,
        activeDeliveries,
        load,
      };
    });
    rows.sort((a, b) => (b.load ?? 0) - (a.load ?? 0));
    return { canManage: can(ctx, "org.members.manage"), rows };
  });
}

export async function saveResourceProfile(ctx: ServiceContext, input: z.output<typeof profileSchema>) {
  assertCan(ctx, "org.members.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    if (!(await tx.membership.findFirst({ where: { userId: input.userId, status: "ACTIVE" } }))) throw new NotFoundError();
    const { userId, ...data } = input;
    const p = await tx.resourceProfile.upsert({ where: { organizationId_userId: { organizationId: ctx.orgId, userId } }, create: { ...data, userId, organizationId: ctx.orgId }, update: data });
    await audit(tx, ctx, { action: "resource.update", entityType: "RESOURCE", entityId: p.id, summary: `${data.kind} · ${data.dailyCapacity}` });
    return p;
  });
}
