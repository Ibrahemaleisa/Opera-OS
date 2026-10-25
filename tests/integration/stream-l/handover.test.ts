/**
 * BUSINESS_RULES §2 — departure and handover (HO-1 … HO-9). Stream L, Milestone 2.
 */
import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { requestApproval } from "@/server/modules/approvals/service";
import { handoverPreview, saveRole, setMemberStatus } from "@/server/modules/org/service";
import { operationsBoard } from "@/server/modules/operations/service";
import { removeProjectMember, saveDeliverable, upsertProjectMember } from "@/server/modules/projects/service";
import { addMember, createAgency } from "../../helpers";
import { blankProject, membershipId, task, type Agency } from "../qa-audit/qa-helpers";
import { adminDb, DAY, member, seedCampaign, seedDelivery, seedEvent, seedShift } from "./fixtures";


async function incident(a: Agency, projectId: string, ownerId: string, title: string) {
  return withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.incident.create({ data: { organizationId: a.orgId, projectId, title, reportedById: a.userId, ownerId } }));
}

/** A PM holding 5 open tasks, 1 designated approval, 2 incidents and 3 future shifts. */
async function busyPM(a: Agency) {
  const pm = await addMember(a.ctx, "project_manager", "Departing PM");
  const p = await blankProject(a.ctx, "Busy project", { eventStartAt: new Date(Date.now() + 20 * DAY) });
  await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER", { canApprove: true }));
  const tasks = [];
  for (let i = 1; i <= 5; i++) tasks.push(await task(a.ctx, p.id, `Task ${i}`, { ownerId: pm.userId, dueAt: new Date(Date.now() + i * DAY) }));
  const gated = await task(a.ctx, p.id, "Owner's gated task", { requiresApproval: true });
  const approval = await requestApproval(a.ctx, { projectId: p.id, entityType: "TASK", entityId: gated.id, title: "Gated", approverType: "INTERNAL", approverUserId: pm.userId });
  const incidents = [await incident(a, p.id, pm.userId, "Generator noise"), await incident(a, p.id, pm.userId, "Badge printer jam")];
  const event = await seedEvent(a, p.id);
  const shifts = [await seedShift(a, event.id, pm.userId, 10), await seedShift(a, event.id, pm.userId, 11), await seedShift(a, event.id, pm.userId, 12)];
  return { pm, p, tasks, approval, incidents, event, shifts };
}

describe("§2 departure and handover", () => {
  it("HO-1 one replacement takes all 11 items in one transaction and gets exactly one notice", async () => {
    const a = await createAgency("HO1");
    const { pm, p, tasks, approval, incidents, shifts } = await busyPM(a);
    const next = await addMember(a.ctx, "project_manager", "Replacement PM");
    await setMemberStatus(a.ctx, { membershipId: await membershipId(a.orgId, pm.userId), status: "SUSPENDED", handover: { replacementId: next.userId } });
    expect(await adminDb().task.count({ where: { id: { in: tasks.map((t) => t.id) }, ownerId: next.userId } })).toBe(5);
    expect((await adminDb().approval.findUniqueOrThrow({ where: { id: approval.id } })).approverUserId).toBe(next.userId);
    expect(await adminDb().incident.count({ where: { id: { in: incidents.map((i) => i.id) }, ownerId: next.userId } })).toBe(2);
    expect(await adminDb().shift.count({ where: { id: { in: shifts.map((s) => s.id) }, userId: next.userId } })).toBe(3);
    expect(await adminDb().notification.count({ where: { userId: next.userId, type: "handover.assigned" } })).toBe(1);
    expect(await adminDb().notification.count({ where: { userId: pm.userId, createdAt: { gte: new Date(Date.now() - 60_000) }, type: { startsWith: "handover" } } })).toBe(0);
    expect((await adminDb().projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId: p.id, userId: next.userId } } })).role).toBe("MANAGER");
    expect(await adminDb().taskAssignmentHistory.count({ where: { taskId: { in: tasks.map((t) => t.id) }, reason: "handover" } })).toBe(5);
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "member.handover" } })).toBe(1);
  });

  it("HO-2 the only PM of an ACTIVE project can't be suspended without a replacement PM", async () => {
    const a = await createAgency("HO2");
    const pm = await addMember(a.ctx, "project_manager", "Only PM");
    const p = await blankProject(a.ctx, "Solo-managed");
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER"));
    await removeProjectMember(a.ctx, p.id, a.userId); // the creator steps back; PM is now the only manager
    const mid = await membershipId(a.orgId, pm.userId);
    await expect(setMemberStatus(a.ctx, { membershipId: mid, status: "SUSPENDED" })).rejects.toThrow("errors.lastManager");
    expect((await adminDb().membership.findUniqueOrThrow({ where: { id: mid } })).status).toBe("ACTIVE");
    // a replacement without project.manage is not enough either
    const emp = await addMember(a.ctx, "employee", "Coordinator");
    await expect(setMemberStatus(a.ctx, { membershipId: mid, status: "SUSPENDED", handover: { perCategory: { H6: emp.userId } } })).rejects.toThrow("errors.replacementNotEligible");
  });

  it("HO-3 a replacement without decide authority: the designation is cleared and the pool keeps the approval", async () => {
    const a = await createAgency("HO3");
    const { pm, approval } = await busyPM(a);
    const director = await addMember(a.ctx, "ops_director", "Director"); // the remaining pool
    void director;
    const emp = await addMember(a.ctx, "employee", "Coordinator");
    const pm2 = await addMember(a.ctx, "project_manager", "Next PM");
    await setMemberStatus(a.ctx, { membershipId: await membershipId(a.orgId, pm.userId), status: "SUSPENDED", handover: { replacementId: pm2.userId, perCategory: { H3: emp.userId } } });
    const after = await adminDb().approval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(after.status).toBe("PENDING");
    expect(after.approverUserId).toBeNull();
    expect(await adminDb().auditEvent.count({ where: { action: "approval.reassigned", entityId: approval.entityId } })).toBe(1);
  });

  it("HO-3 with an empty pool the approval is cancelled with revert and the requester is told", async () => {
    const a = await createAgency("HO3 empty");
    const pm = await addMember(a.ctx, "project_manager", "Designated approver");
    const hr = await saveRole(a.ctx, { nameAr: "موارد بشرية", nameEn: "People admin", baseRole: "EMPLOYEE", permissions: ["org.members.view", "org.members.manage"] });
    const admin = await addMember(a.ctx, hr.key, "People admin");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER", { canApprove: true }));
    const d = await saveDeliverable(a.ctx, { projectId: p.id, title: "Floor plan", status: "IN_PROGRESS", clientVisible: false, requiresApproval: true });
    const appr = await requestApproval(a.ctx, { projectId: p.id, entityType: "DELIVERABLE", entityId: d.id, title: "Floor plan", approverType: "INTERNAL", approverUserId: pm.userId });
    await setMemberStatus(admin.ctx, { membershipId: await membershipId(a.orgId, pm.userId), status: "SUSPENDED" });
    expect((await adminDb().approval.findUniqueOrThrow({ where: { id: appr.id } })).status).toBe("CANCELLED");
    expect((await adminDb().deliverable.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("IN_PROGRESS");
    expect(await adminDb().notification.count({ where: { userId: a.userId, type: "approval.cancelled", entityId: d.id } })).toBe(1);
  });

  it("HO-4 'leave unowned' tasks have no owner and show under 'Unowned after departure' with the person's name", async () => {
    const a = await createAgency("HO4");
    const { pm, tasks } = await busyPM(a);
    const pm2 = await addMember(a.ctx, "project_manager", "Next PM");
    await setMemberStatus(a.ctx, { membershipId: await membershipId(a.orgId, pm.userId), status: "SUSPENDED", handover: { replacementId: pm2.userId, perCategory: { H1: "UNOWNED" } } });
    expect(await adminDb().task.count({ where: { id: { in: tasks.map((t) => t.id) }, ownerId: null } })).toBe(5);
    const board = await operationsBoard(a.ctx);
    const group = board.exceptions.find((g) => g.kind === "unownedAfterDeparture");
    expect(group?.rows.map((r) => r.id).sort()).toEqual(tasks.map((t) => t.id).sort());
    expect(group?.rows[0].meta.departed).toBe("Departing PM");
  });

  it("HO-5 an agent's ASSIGNED delivery returns to READY with history, the in-car one is escalated (M1 regression)", async () => {
    const a = await createAgency("HO5");
    const agent = await addMember(a.ctx, "field_agent", "Driver");
    const p = await blankProject(a.ctx);
    const { campaign, recipients: rs } = await seedCampaign(a, p.id, { type: "PHYSICAL", status: "ACTIVE", n: 2 });
    const assigned = await seedDelivery(a, p.id, campaign.id, rs[0].id, "ASSIGNED", agent.userId);
    const inCar = await seedDelivery(a, p.id, campaign.id, rs[1].id, "OUT_FOR_DELIVERY", agent.userId);
    await setMemberStatus(a.ctx, { membershipId: await membershipId(a.orgId, agent.userId), status: "SUSPENDED" });
    const d1 = await adminDb().delivery.findUniqueOrThrow({ where: { id: assigned.id } });
    expect([d1.status, d1.agentId]).toEqual(["READY", null]);
    expect(await adminDb().deliveryEvent.count({ where: { deliveryId: assigned.id, toStatus: "READY" } })).toBe(1);
    expect((await adminDb().delivery.findUniqueOrThrow({ where: { id: inCar.id } })).escalatedAt).not.toBeNull();
  });

  it("HO-6 a clashing shift is left open and listed; the rest of the handover succeeds", async () => {
    const a = await createAgency("HO6");
    const { pm, tasks, event, shifts } = await busyPM(a);
    const pm2 = await addMember(a.ctx, "project_manager", "Next PM");
    // pm2 already works the first shift's slot
    const first = await adminDb().shift.findUniqueOrThrow({ where: { id: shifts[0].id } });
    await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.shift.create({ data: { organizationId: a.orgId, eventId: event.id, userId: pm2.userId, role: "Host", startsAt: first.startsAt, endsAt: first.endsAt } }));
    const result = await setMemberStatus(a.ctx, { membershipId: await membershipId(a.orgId, pm.userId), status: "SUSPENDED", handover: { replacementId: pm2.userId } });
    expect(result?.shiftClashes).toEqual([shifts[0].id]);
    expect((await adminDb().shift.findUniqueOrThrow({ where: { id: shifts[0].id } })).userId).toBeNull();
    expect(await adminDb().shift.count({ where: { id: { in: [shifts[1].id, shifts[2].id] }, userId: pm2.userId } })).toBe(2);
    expect(await adminDb().task.count({ where: { id: { in: tasks.map((t) => t.id) }, ownerId: pm2.userId } })).toBe(5);
  });

  it("HO-7 a REVOKED member can't be set ACTIVE again", async () => {
    const a = await createAgency("HO7");
    const emp = await addMember(a.ctx, "employee", "Leaver");
    const mid = await membershipId(a.orgId, emp.userId);
    await setMemberStatus(a.ctx, { membershipId: mid, status: "REVOKED" });
    await expect(setMemberStatus(a.ctx, { membershipId: mid, status: "ACTIVE" })).rejects.toThrow("errors.revokedIsFinal");
  });

  it("HO-8 reactivating a suspended member hands nothing back", async () => {
    const a = await createAgency("HO8");
    const { pm, tasks } = await busyPM(a);
    const pm2 = await addMember(a.ctx, "project_manager", "Next PM");
    const mid = await membershipId(a.orgId, pm.userId);
    await setMemberStatus(a.ctx, { membershipId: mid, status: "SUSPENDED", handover: { replacementId: pm2.userId } });
    await setMemberStatus(a.ctx, { membershipId: mid, status: "ACTIVE" });
    expect((await adminDb().membership.findUniqueOrThrow({ where: { id: mid } })).status).toBe("ACTIVE");
    expect(await adminDb().task.count({ where: { id: { in: tasks.map((t) => t.id) }, ownerId: pm.userId } })).toBe(0);
  });

  it("HO-9 the preview's counts equal the rows the execution changes", async () => {
    const a = await createAgency("HO9");
    const { pm } = await busyPM(a);
    const pm2 = await addMember(a.ctx, "project_manager", "Next PM");
    const mid = await membershipId(a.orgId, pm.userId);
    const preview = await handoverPreview(a.ctx, mid);
    const count = (k: string) => preview.rows.find((r) => r.key === k)!.count;
    expect([count("H1"), count("H3"), count("H6"), count("H7"), count("H12")]).toEqual([5, 1, 1, 2, 3]);
    const expected = Object.fromEntries(preview.rows.map((r) => [r.key, r.count]));
    const result = await setMemberStatus(a.ctx, { membershipId: mid, status: "SUSPENDED", handover: { replacementId: pm2.userId, expected } });
    for (const k of ["H1", "H3", "H6", "H7", "H12"]) expect([k, (result?.moved as Record<string, number>)[k] ?? 0]).toEqual([k, count(k)]);
  });

  it("HO rule 1 holdings that changed since the preview refuse the handover and change nothing", async () => {
    const a = await createAgency("HO stale");
    const { pm, p } = await busyPM(a);
    const pm2 = await addMember(a.ctx, "project_manager", "Next PM");
    const mid = await membershipId(a.orgId, pm.userId);
    const preview = await handoverPreview(a.ctx, mid);
    await task(a.ctx, p.id, "Added meanwhile", { ownerId: pm.userId });
    const expected = Object.fromEntries(preview.rows.map((r) => [r.key, r.count]));
    await expect(setMemberStatus(a.ctx, { membershipId: mid, status: "SUSPENDED", handover: { replacementId: pm2.userId, expected } })).rejects.toThrow("errors.staleWrite");
    expect((await adminDb().membership.findUniqueOrThrow({ where: { id: mid } })).status).toBe("ACTIVE");
  });

  it("§2.3 suspending an owner is told to the other owners", async () => {
    const a = await createAgency("HO owner");
    const owner2 = await addMember(a.ctx, "owner", "Co-owner");
    const owner3 = await addMember(a.ctx, "owner", "Third owner");
    await setMemberStatus(a.ctx, { membershipId: await membershipId(a.orgId, owner2.userId), status: "SUSPENDED" });
    expect(await adminDb().notification.count({ where: { userId: owner3.userId, type: "member.departed" } })).toBe(1);
    expect(await adminDb().notification.count({ where: { userId: owner2.userId, type: "member.departed" } })).toBe(0);
  });
});
