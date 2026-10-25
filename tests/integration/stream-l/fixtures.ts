/**
 * Stream L (Milestone 2) fixtures: lifecycle, handover and approval policy. Rows are seeded straight
 * into the tenant tables when the path that would create them is not what the test is about.
 */
import type { ServiceContext } from "@/server/authz/context";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { setProjectStatus, upsertProjectMember } from "@/server/modules/projects/service";
import { addMember } from "../../helpers";
import { blankProject, task, type Agency } from "../qa-audit/qa-helpers";

export const DAY = 86_400_000;
export const REASON = "Client withdrew the event budget for this year";

type Role = "MANAGER" | "LEAD" | "MEMBER" | "FREELANCER" | "CLIENT_APPROVER" | "CLIENT_VIEWER" | "FIELD_AGENT";
export const member = (projectId: string, userId: string, role: Role, extra: Partial<{ canApprove: boolean; canViewFinance: boolean; canViewVip: boolean }> = {}) => ({
  projectId, userId, role, canApprove: extra.canApprove ?? false, canExport: false, canViewFinance: extra.canViewFinance ?? false, canViewVip: extra.canViewVip ?? false, workstreamIds: [],
});

export const version = async (projectId: string) => (await adminDb().project.findUniqueOrThrow({ where: { id: projectId }, select: { version: true } })).version;

/** Moves a project through the lifecycle with the right versions (no reason needed for these hops). */
export async function moveTo(ctx: ServiceContext, projectId: string, status: "ACTIVE" | "COMPLETED", reason?: string) {
  if (status === "ACTIVE" || status === "COMPLETED") await setProjectStatus(ctx, projectId, "ACTIVE", { version: await version(projectId), reason });
  if (status === "COMPLETED") await setProjectStatus(ctx, projectId, "COMPLETED", { version: await version(projectId) });
}

/** An ACTIVE project (anchored, with an active PM) plus a director and a PM. */
export async function activeProject(a: Agency, name = "Lifecycle project") {
  const director = await addMember(a.ctx, "ops_director", "Director");
  const pm = await addMember(a.ctx, "project_manager", "PM");
  const p = await blankProject(a.ctx, name, { eventStartAt: new Date(Date.now() + 30 * DAY) });
  await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER", { canApprove: true, canViewFinance: true }));
  await moveTo(a.ctx, p.id, "ACTIVE");
  return { p, director, pm };
}

let seq = 0;
const code = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

/** A campaign with `n` recipients; digital campaigns get invitations and QUEUED message jobs. */
export async function seedCampaign(a: Agency, projectId: string, opts: { type?: "DIGITAL" | "PHYSICAL"; status: string; n?: number; scheduledAt?: Date | null }) {
  const batch = ++seq;
  const rs = opts.n
    ? await withTenant({ orgId: a.orgId, userId: a.userId }, async (tx) => {
        const out = [];
        for (let i = 1; i <= opts.n!; i++) out.push(await tx.recipient.create({ data: { organizationId: a.orgId, projectId, code: `B${batch}-${i}`, nameAr: `ضيف ${i}`, mobile: `+9665552${String(batch).padStart(2, "0")}${String(i).padStart(3, "0")}`, city: "الرياض", createdById: a.userId } }));
        return out;
      })
    : [];
  return withTenant({ orgId: a.orgId, userId: a.userId }, async (tx) => {
    const c = await tx.invitationCampaign.create({ data: { organizationId: a.orgId, projectId, type: opts.type ?? "DIGITAL", name: code("Campaign"), status: opts.status as never, channel: opts.type === "PHYSICAL" ? null : "SMS", bodyTemplate: "{{name}}", scheduledAt: opts.scheduledAt ?? null, createdById: a.userId } });
    if ((opts.type ?? "DIGITAL") === "DIGITAL") {
      for (const r of rs) {
        const inv = await tx.digitalInvitation.create({ data: { organizationId: a.orgId, projectId, campaignId: c.id, recipientId: r.id, channel: "SMS", address: r.mobile ?? "+966555000000" } });
        await tx.messageJob.create({ data: { organizationId: a.orgId, invitationId: inv.id, channel: "SMS", provider: "simulation", to: inv.address, body: "hi", idempotencyKey: `${c.id}:${inv.id}:initial` } });
      }
    }
    return { campaign: c, recipients: rs };
  });
}

export async function seedDelivery(a: Agency, projectId: string, campaignId: string, recipientId: string, status: string, agentId: string | null) {
  return withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.delivery.create({ data: { organizationId: a.orgId, projectId, campaignId, recipientId, trackingCode: code("TRK"), status: status as never, agentId } }));
}

export async function seedVendor(a: Agency) {
  return withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.vendor.create({ data: { organizationId: a.orgId, name: code("Vendor"), category: "PRINTING" } }));
}

export async function seedPO(a: Agency, projectId: string, vendorId: string, status: string, amount = 1000) {
  return withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.purchaseOrder.create({ data: { organizationId: a.orgId, projectId, vendorId, code: code("PO"), title: "Print run", budgetCategory: "PRINTING", amount, vatAmount: 0, status: status as never, createdById: a.userId } }));
}

export async function seedEvent(a: Agency, projectId: string, phase = "PLANNING") {
  return withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.event.create({ data: { organizationId: a.orgId, projectId, name: code("Event"), startsAt: new Date(Date.now() + 20 * DAY), endsAt: new Date(Date.now() + 21 * DAY), phase: phase as never } }));
}

export async function seedShift(a: Agency, eventId: string, userId: string | null, startsInDays = 20) {
  const startsAt = new Date(Date.now() + startsInDays * DAY);
  return withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.shift.create({ data: { organizationId: a.orgId, eventId, userId, role: "Usher", startsAt, endsAt: new Date(startsAt.getTime() + 4 * 3_600_000) } }));
}

/** A pending approval row on any entity (the cascade does not care how it was requested). */
export async function seedApproval(a: Agency, projectId: string, entityType: string, entityId: string, requestedById: string) {
  return withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.approval.create({ data: { organizationId: a.orgId, projectId, entityType, entityId, title: `${entityType} approval`, requestedById, dueAt: new Date(Date.now() + 2 * DAY) } }));
}

/** Every row type of §1.3, for the LC-14 preview = execution check. */
export async function everyRowType(a: Agency, p: { id: string }, people: { pm: string; staff: string; agent: string }) {
  const t1 = await task(a.ctx, p.id, "Overdue venue contract", { ownerId: people.pm, dueAt: new Date(Date.now() - 2 * DAY) });
  const t2 = await task(a.ctx, p.id, "Badge artwork", { ownerId: people.staff });
  await task(a.ctx, p.id, "Subtask", { parentId: t2.id });
  const vendor = await seedVendor(a);
  const scheduled = await seedCampaign(a, p.id, { status: "SCHEDULED", n: 3, scheduledAt: new Date(Date.now() + 5 * DAY) });
  await seedCampaign(a, p.id, { status: "DRAFT" });
  await seedCampaign(a, p.id, { status: "ACTIVE" });
  const physical = await seedCampaign(a, p.id, { type: "PHYSICAL", status: "ACTIVE", n: 3 });
  await seedDelivery(a, p.id, physical.campaign.id, physical.recipients[0].id, "ASSIGNED", people.agent);
  await seedDelivery(a, p.id, physical.campaign.id, physical.recipients[1].id, "OUT_FOR_DELIVERY", people.agent);
  await seedDelivery(a, p.id, physical.campaign.id, physical.recipients[2].id, "DELIVERED", people.agent);
  const draftPO = await seedPO(a, p.id, vendor.id, "DRAFT");
  const pendingPO = await seedPO(a, p.id, vendor.id, "PENDING_APPROVAL");
  await seedPO(a, p.id, vendor.id, "ISSUED");
  await seedApproval(a, p.id, "PURCHASE_ORDER", pendingPO.id, a.userId);
  await seedApproval(a, p.id, "TASK", t1.id, people.staff);
  const expense = await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.expense.create({ data: { organizationId: a.orgId, projectId: p.id, budgetCategory: "PRINTING", description: "Cancellation fee", amount: 500, incurredAt: new Date(), submittedById: a.userId } }));
  const expenseApproval = await seedApproval(a, p.id, "EXPENSE", expense.id, a.userId);
  await withTenant({ orgId: a.orgId, userId: a.userId }, async (tx) => {
    await tx.workOrder.create({ data: { organizationId: a.orgId, projectId: p.id, vendorId: vendor.id, title: "Stage build", status: "ISSUED", createdById: a.userId } });
    await tx.workOrder.create({ data: { organizationId: a.orgId, projectId: p.id, vendorId: vendor.id, title: "Signage", status: "IN_PROGRESS", createdById: a.userId } });
    await tx.guest.createMany({ data: [0, 1].map((i) => ({ organizationId: a.orgId, projectId: p.id, nameAr: `ضيف ${i}`, attendance: "EXPECTED" as const })) });
    await tx.guest.create({ data: { organizationId: a.orgId, projectId: p.id, nameAr: "ضيف حاضر", attendance: "ARRIVED" } });
    await tx.changeRequest.create({ data: { organizationId: a.orgId, projectId: p.id, title: "Add a VIP lounge", description: "Please add a lounge", requestedById: a.userId } });
    await tx.incident.create({ data: { organizationId: a.orgId, projectId: p.id, title: "Power cut in hall B", reportedById: a.userId } });
  });
  const event = await seedEvent(a, p.id);
  await seedShift(a, event.id, people.staff);
  await seedShift(a, event.id, people.staff, -1); // started: unchanged
  return { t1, t2, scheduled, physical, draftPO, pendingPO, expense, expenseApproval, vendor, event };
}

export { adminDb };
