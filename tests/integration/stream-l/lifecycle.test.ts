/**
 * BUSINESS_RULES §1 — project lifecycle (LC-1 … LC-14) and §6 concurrent editing on projects
 * (CE-1, CE-3, CE-5). Stream L, Milestone 2.
 */
import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { decideApproval } from "@/server/modules/approvals/service";
import { kickOutbox } from "@/server/jobs/dispatch";
import { dispatchDueCampaigns } from "@/server/modules/digital/sender";
import { addAudience, launchCampaign, requestCampaignApproval, saveDigitalCampaign } from "@/server/modules/digital/service";
import { setPurchaseOrderStatus } from "@/server/modules/finance/service";
import { saveRole } from "@/server/modules/org/service";
import { portalHome, portalProject } from "@/server/modules/portal/service";
import { previewProjectStatusChange, saveDeliverable, saveMilestone, saveRisk, setProjectStatus, updateProject, upsertProjectMember } from "@/server/modules/projects/service";
import { requestApproval } from "@/server/modules/approvals/service";
import { bulkUpdateTasks, changeTaskStatus, updateTask } from "@/server/modules/tasks/service";
import { schedulerTick } from "@/server/modules/automation/scheduler";
import { ALL_PERMISSIONS } from "@/server/authz/permissions";
import { addMember, createAgency } from "../../helpers";
import { blankProject, clientUser, createClientCompany, recipients, task, templateId } from "../qa-audit/qa-helpers";
import { activeProject, adminDb, DAY, everyRowType, member, moveTo, REASON, seedCampaign, seedDelivery, seedPO, seedVendor, version } from "./fixtures";

const OPS_PERMISSIONS = ALL_PERMISSIONS.filter((x) => !["org.roles.manage", "portal.access", "portal.approve", "vendor.portal"].includes(x));
const projectRow = (id: string) => adminDb().project.findUniqueOrThrow({ where: { id } });
const codeOf = (e: unknown) => (e as { code?: string }).code;
const messageOf = (e: unknown) => (e as Error).message;
const fieldsOf = (e: unknown) => (e as { fieldErrors?: Record<string, string[]> }).fieldErrors ?? {};

describe("§1.2 transitions, roles and reasons", () => {
  it("LC-9 a PM cannot cancel an ACTIVE project but can put it on hold with a reason", async () => {
    const a = await createAgency("LC9");
    const { p, pm } = await activeProject(a);
    await expect(setProjectStatus(pm.ctx, p.id, "CANCELLED", { version: await version(p.id), reason: REASON })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setProjectStatus(pm.ctx, p.id, "ON_HOLD", { version: await version(p.id) })).rejects.toThrow("errors.reasonRequired");
    const held = await setProjectStatus(pm.ctx, p.id, "ON_HOLD", { version: await version(p.id), reason: "Waiting for the venue permit" });
    expect(held.status).toBe("ON_HOLD");
    expect(held.statusReason).toBe("Waiting for the venue permit");
    expect(held.statusChangedById).toBe(pm.userId);
    // resume goes back to the status before the hold, and only there
    await expect(setProjectStatus(pm.ctx, p.id, "PLANNING", { version: held.version })).rejects.toThrow("errors.invalidTransition");
    expect((await setProjectStatus(pm.ctx, p.id, "ACTIVE", { version: held.version })).status).toBe("ACTIVE");
  });

  it("LC rule 2 / CE-3 a status change without the loaded version is refused, a stale one conflicts", async () => {
    const a = await createAgency("LC version");
    const { p } = await activeProject(a);
    await expect(setProjectStatus(a.ctx, p.id, "ON_HOLD", { reason: REASON })).rejects.toThrow("errors.versionRequired");
    const v = await version(p.id);
    await setProjectStatus(a.ctx, p.id, "ON_HOLD", { version: v, reason: REASON });
    await expect(setProjectStatus(a.ctx, p.id, "CANCELLED", { version: v, reason: REASON })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("gate A1: activation needs an anchor date and an active PM; AT_RISK is never offered", async () => {
    const a = await createAgency("LC A1");
    const p = await blankProject(a.ctx, "No dates");
    await expect(setProjectStatus(a.ctx, p.id, "ACTIVE", { version: await version(p.id) })).rejects.toThrow("errors.activationGate");
    await expect(setProjectStatus(a.ctx, p.id, "AT_RISK", { version: await version(p.id) })).rejects.toThrow();
  });

  it("an unlisted pair is refused with errors.invalidTransition", async () => {
    const a = await createAgency("LC invalid");
    const { p } = await activeProject(a);
    await expect(setProjectStatus(a.ctx, p.id, "CLOSED", { version: await version(p.id), reason: REASON })).rejects.toThrow("errors.invalidTransition");
  });
});

describe("§1.3 cancel cascade", () => {
  it("LC-1 a director cancelling a project cancels its overdue owned task in the same transaction ([F-22])", async () => {
    const a = await createAgency("LC1");
    const { p, director, pm } = await activeProject(a);
    const t = await task(a.ctx, p.id, "Overdue venue contract", { ownerId: pm.userId, dueAt: new Date(Date.now() - 2 * DAY) });
    await setProjectStatus(director.ctx, p.id, "CANCELLED", { version: await version(p.id), reason: REASON });
    const after = await adminDb().task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.statusCategory).toBe("CANCELLED");
    expect(after.status).toBe("cancelled");
    expect((await projectRow(p.id)).archivedAt).not.toBeNull();
    const row = await adminDb().auditEvent.findFirstOrThrow({ where: { entityId: t.id, action: "task.status" }, orderBy: { createdAt: "desc" } });
    expect((row.meta as { cause?: string }).cause).toBe("project_cancelled");
  });

  it("LC-2 a SCHEDULED campaign with 40 queued messages is cancelled and nothing is sent afterwards", async () => {
    const a = await createAgency("LC2");
    const { p, director } = await activeProject(a);
    const { campaign } = await seedCampaign(a, p.id, { status: "SCHEDULED", n: 40, scheduledAt: new Date(Date.now() + DAY) });
    await setProjectStatus(director.ctx, p.id, "CANCELLED", { version: await version(p.id), reason: REASON });
    await adminDb().invitationCampaign.update({ where: { id: campaign.id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    await dispatchDueCampaigns(a.orgId);
    await kickOutbox(a.orgId);
    expect((await adminDb().invitationCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("CANCELLED");
    expect(await adminDb().messageJob.count({ where: { invitation: { campaignId: campaign.id }, status: "CANCELLED" } })).toBe(40);
    expect(await adminDb().messageJob.count({ where: { invitation: { campaignId: campaign.id }, status: { in: ["SENDING", "SENT", "DELIVERED"] } } })).toBe(0);
    const row = await adminDb().auditEvent.findFirstOrThrow({ where: { entityId: campaign.id, action: "campaign.cancel" } });
    expect((row.meta as { cause?: string }).cause).toBe("project_cancelled");
  });

  it("LC-3 an ASSIGNED delivery is cancelled and unassigned; an in-car one is escalated and its agent gets a notice", async () => {
    const a = await createAgency("LC3");
    const { p, director } = await activeProject(a);
    const agent = await addMember(a.ctx, "field_agent", "Driver");
    const { campaign, recipients: rs } = await seedCampaign(a, p.id, { type: "PHYSICAL", status: "ACTIVE", n: 2 });
    const assigned = await seedDelivery(a, p.id, campaign.id, rs[0].id, "ASSIGNED", agent.userId);
    const inCar = await seedDelivery(a, p.id, campaign.id, rs[1].id, "OUT_FOR_DELIVERY", agent.userId);
    await setProjectStatus(director.ctx, p.id, "CANCELLED", { version: await version(p.id), reason: REASON });
    const d1 = await adminDb().delivery.findUniqueOrThrow({ where: { id: assigned.id } });
    const d2 = await adminDb().delivery.findUniqueOrThrow({ where: { id: inCar.id } });
    expect(d1.status).toBe("CANCELLED");
    expect(d1.agentId).toBeNull();
    expect(d2.status).toBe("OUT_FOR_DELIVERY");
    expect(d2.escalatedAt).not.toBeNull();
    expect(await adminDb().notification.count({ where: { userId: agent.userId, title: "projects.lifecycle.notices.returnToOffice" } })).toBe(1);
  });

  it("LC-4 DRAFT and PENDING_APPROVAL POs are cancelled, an ISSUED PO is listed and still receivable", async () => {
    const a = await createAgency("LC4");
    const { p, director } = await activeProject(a);
    const v = await seedVendor(a);
    const draft = await seedPO(a, p.id, v.id, "DRAFT");
    const pending = await seedPO(a, p.id, v.id, "PENDING_APPROVAL");
    const issued = await seedPO(a, p.id, v.id, "ISSUED");
    const preview = await previewProjectStatusChange(director.ctx, p.id, "CANCELLED");
    expect(preview.rows.find((r) => r.key === "vendorCancellation")?.items.map((i) => i.id)).toEqual([issued.id]);
    await setProjectStatus(director.ctx, p.id, "CANCELLED", { version: await version(p.id), reason: REASON });
    const statuses = Object.fromEntries((await adminDb().purchaseOrder.findMany({ where: { projectId: p.id } })).map((x) => [x.id, x.status]));
    expect(statuses).toEqual({ [draft.id]: "CANCELLED", [pending.id]: "CANCELLED", [issued.id]: "ISSUED" });
    await setPurchaseOrderStatus(a.ctx, { id: issued.id, status: "RECEIVED" });
    expect((await adminDb().purchaseOrder.findUniqueOrThrow({ where: { id: issued.id } })).status).toBe("RECEIVED");
  });

  it("LC-5 a PENDING expense approval stays PENDING and a finance approver can still decide it", async () => {
    const a = await createAgency("LC5");
    const { p, director } = await activeProject(a);
    const e = await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.expense.create({ data: { organizationId: a.orgId, projectId: p.id, budgetCategory: "VENUE", description: "Venue deposit", amount: 9000, incurredAt: new Date(), submittedById: a.userId } }));
    const appr = await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.approval.create({ data: { organizationId: a.orgId, projectId: p.id, entityType: "EXPENSE", entityId: e.id, title: "Venue deposit", requestedById: a.userId } }));
    await setProjectStatus(director.ctx, p.id, "CANCELLED", { version: await version(p.id), reason: REASON });
    expect((await adminDb().approval.findUniqueOrThrow({ where: { id: appr.id } })).status).toBe("PENDING");
    expect((await decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).status).toBe("APPROVED");
    expect((await adminDb().expense.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("APPROVED");
  });

  it("LC-6 in an archived project a PM's edits to a task, milestone or risk are refused and versions stay", async () => {
    const a = await createAgency("LC6");
    const { p, director, pm } = await activeProject(a);
    const t = await task(a.ctx, p.id, "Print badges", { ownerId: pm.userId });
    const ms = await saveMilestone(pm.ctx, { projectId: p.id, title: "Venue locked", status: "IN_PROGRESS", clientVisible: true });
    const r = await saveRisk(pm.ctx, { projectId: p.id, title: "Rain", likelihood: 2, impact: 3, status: "OPEN" });
    await setProjectStatus(director.ctx, p.id, "CANCELLED", { version: await version(p.id), reason: REASON });
    const tBefore = await adminDb().task.findUniqueOrThrow({ where: { id: t.id } });
    await expect(updateTask(pm.ctx, { id: t.id, title: "Edited", version: tBefore.version })).rejects.toThrow("errors.projectArchived");
    await expect(changeTaskStatus(pm.ctx, { id: t.id, status: "todo" })).rejects.toThrow("errors.projectArchived");
    await expect(saveMilestone(pm.ctx, { id: ms.id, projectId: p.id, title: "Edited", status: "DONE", clientVisible: true, version: ms.version })).rejects.toThrow("errors.projectArchived");
    await expect(saveRisk(pm.ctx, { id: r.id, projectId: p.id, title: "Edited", likelihood: 5, impact: 5, status: "OPEN", version: r.version })).rejects.toThrow("errors.projectArchived");
    expect((await adminDb().task.findUniqueOrThrow({ where: { id: t.id } })).version).toBe(tBefore.version);
    expect((await adminDb().milestone.findUniqueOrThrow({ where: { id: ms.id } })).version).toBe(ms.version);
    expect((await adminDb().risk.findUniqueOrThrow({ where: { id: r.id } })).version).toBe(r.version);
  });

  it("LC-13 reopening a cancelled project returns it to PLANNING, clears archivedAt and keeps cancelled tasks cancelled", async () => {
    const a = await createAgency("LC13");
    const { p, director, pm } = await activeProject(a);
    const t = await task(a.ctx, p.id, "Book the hall", { ownerId: pm.userId });
    await setProjectStatus(director.ctx, p.id, "CANCELLED", { version: await version(p.id), reason: REASON });
    await expect(setProjectStatus(pm.ctx, p.id, "PLANNING", { version: await version(p.id), reason: REASON })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setProjectStatus(director.ctx, p.id, "PLANNING", { version: await version(p.id) })).rejects.toThrow("errors.reasonRequired");
    const reopened = await setProjectStatus(director.ctx, p.id, "PLANNING", { version: await version(p.id), reason: "The client reinstated the budget" });
    expect(reopened.status).toBe("PLANNING");
    expect(reopened.archivedAt).toBeNull();
    expect((await adminDb().task.findUniqueOrThrow({ where: { id: t.id } })).statusCategory).toBe("CANCELLED");
    expect(await adminDb().auditEvent.count({ where: { entityId: p.id, action: "project.reopen" } })).toBe(1);
  });

  it("LC-14 the cancel preview counts equal the rows the cascade changes (every row type)", async () => {
    const a = await createAgency("LC14");
    const { p, director, pm } = await activeProject(a);
    const staff = await addMember(a.ctx, "employee", "Staff");
    const agent = await addMember(a.ctx, "field_agent", "Driver");
    await upsertProjectMember(a.ctx, member(p.id, staff.userId, "MEMBER"));
    const f = await everyRowType(a, p, { pm: pm.userId, staff: staff.userId, agent: agent.userId });
    const preview = await previewProjectStatusChange(director.ctx, p.id, "CANCELLED");
    expect(preview.allowed).toBe(true);
    expect(preview.reasonRequired).toBe(true);
    await setProjectStatus(director.ctx, p.id, "CANCELLED", { version: preview.version, reason: REASON });
    const cascade = await adminDb().auditEvent.findFirstOrThrow({ where: { entityId: p.id, action: "project.cancel_cascade" } });
    const counts = (cascade.meta as { counts: Record<string, number> }).counts;
    for (const row of preview.rows.filter((r) => r.key in counts)) expect([row.key, counts[row.key]]).toEqual([row.key, row.count]);
    expect(counts).toMatchObject({ tasks: 3, approvals: 2, campaigns: 2, queuedMessages: 3, deliveries: 1, inCarDeliveries: 1, purchaseOrders: 2, vendorCancellation: 1, workOrders: 1, runningWorkOrders: 1, shifts: 1, events: 1, guests: 2, changeRequests: 1 });
    // the counts are what really changed
    expect(await adminDb().task.count({ where: { projectId: p.id, statusCategory: "CANCELLED" } })).toBe(3);
    expect(await adminDb().guest.count({ where: { projectId: p.id, attendance: "CANCELLED" } })).toBe(2);
    expect(await adminDb().shift.count({ where: { eventId: f.event.id, status: "CANCELLED" } })).toBe(1);
    expect((await adminDb().approval.findUniqueOrThrow({ where: { id: f.expenseApproval.id } })).status).toBe("PENDING");
    expect(await adminDb().incident.count({ where: { projectId: p.id, status: "OPEN" } })).toBe(1);
    expect((await adminDb().event.findUniqueOrThrow({ where: { id: f.event.id } })).phase).toBe("CLOSED");
  });

  it("a LIVE event blocks cancellation, with no override", async () => {
    const a = await createAgency("LC live");
    const { p, director } = await activeProject(a);
    await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.event.create({ data: { organizationId: a.orgId, projectId: p.id, name: "Gala", startsAt: new Date(), endsAt: new Date(Date.now() + DAY), phase: "LIVE" } }));
    const err = await setProjectStatus(director.ctx, p.id, "CANCELLED", { version: await version(p.id), reason: REASON }).catch((e) => e);
    expect(messageOf(err)).toBe("errors.liveEventBlocksCancel");
    expect((await projectRow(p.id)).status).toBe("ACTIVE");
  });
});

describe("§1.4 close gates and override", () => {
  it("LC-7 closing with an open task needs a reason (override); a PM is refused either way", async () => {
    const a = await createAgency("LC7");
    const { p, director, pm } = await activeProject(a);
    await moveTo(a.ctx, p.id, "COMPLETED");
    const t = await task(a.ctx, p.id, "Return borrowed AV kit", { ownerId: pm.userId });
    await expect(setProjectStatus(pm.ctx, p.id, "CLOSED", { version: await version(p.id) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setProjectStatus(pm.ctx, p.id, "CLOSED", { version: await version(p.id), reason: REASON })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const refused = await setProjectStatus(director.ctx, p.id, "CLOSED", { version: await version(p.id) }).catch((e) => e);
    expect(messageOf(refused)).toBe("errors.closeGatesOpen");
    expect(fieldsOf(refused).gates).toContain("G1:1");
    const closed = await setProjectStatus(director.ctx, p.id, "CLOSED", { version: await version(p.id), reason: "Client confirmed the kit was returned" });
    expect(closed.status).toBe("CLOSED");
    expect((await adminDb().task.findUniqueOrThrow({ where: { id: t.id } })).statusCategory).toBe("CANCELLED");
    const row = await adminDb().auditEvent.findFirstOrThrow({ where: { entityId: p.id, action: "project.close_override" } });
    expect((row.meta as { gates: Record<string, number> }).gates).toEqual({ G1: 1 });
  });

  it("closing with every gate green needs no reason", async () => {
    const a = await createAgency("LC close green");
    const { p, director } = await activeProject(a);
    await moveTo(a.ctx, p.id, "COMPLETED");
    expect((await setProjectStatus(director.ctx, p.id, "CLOSED", { version: await version(p.id) })).status).toBe("CLOSED");
  });

  it("LC-7b an override over an ISSUED PO needs finance.approve; the owner may close and the PO stays operable", async () => {
    const a = await createAgency("LC7b");
    const { p } = await activeProject(a);
    const role = await saveRole(a.ctx, { nameAr: "مدير بلا مالية", nameEn: "Director without finance approval", baseRole: "OPS_DIRECTOR", permissions: OPS_PERMISSIONS.filter((x) => x !== "finance.approve") });
    const noFinance = await addMember(a.ctx, role.key, "Director without finance");
    const v = await seedVendor(a);
    const po = await seedPO(a, p.id, v.id, "ISSUED");
    await moveTo(a.ctx, p.id, "COMPLETED");
    const refused = await setProjectStatus(noFinance.ctx, p.id, "CLOSED", { version: await version(p.id), reason: REASON }).catch((e) => e);
    expect(messageOf(refused)).toBe("errors.overrideNeedsFinance");
    expect(fieldsOf(refused).gates).toContain("G5:1");
    expect((await setProjectStatus(a.ctx, p.id, "CLOSED", { version: await version(p.id), reason: REASON })).status).toBe("CLOSED");
    expect((await adminDb().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("ISSUED");
    await setPurchaseOrderStatus(a.ctx, { id: po.id, status: "PARTIALLY_RECEIVED" });
  });

  it("LC-8 a delivery out with a driver blocks completing and closing, with no override", async () => {
    const a = await createAgency("LC8");
    const { p, director } = await activeProject(a);
    const agent = await addMember(a.ctx, "field_agent", "Driver");
    const { campaign, recipients: rs } = await seedCampaign(a, p.id, { type: "PHYSICAL", status: "ACTIVE", n: 1 });
    const d = await seedDelivery(a, p.id, campaign.id, rs[0].id, "OUT_FOR_DELIVERY", agent.userId);
    const complete = await setProjectStatus(director.ctx, p.id, "COMPLETED", { version: await version(p.id) }).catch((e) => e);
    expect(messageOf(complete)).toBe("errors.completionGate");
    // even if it got into COMPLETED some other way, close stays blocked with or without a reason
    await adminDb().project.update({ where: { id: p.id }, data: { status: "COMPLETED" } });
    const preview = await previewProjectStatusChange(director.ctx, p.id, "CLOSED");
    expect(preview.blocking.map((g) => g.gate)).toContain("G3");
    expect(preview.override.allowed).toBe(false);
    const close = await setProjectStatus(director.ctx, p.id, "CLOSED", { version: await version(p.id), reason: REASON }).catch((e) => e);
    expect(messageOf(close)).toBe("errors.gateNotOverridable");
    expect((await adminDb().delivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("OUT_FOR_DELIVERY");
  });
});

describe("§1.6 hold and resume", () => {
  it("LC-10 on hold: no overdue notices and no scheduled send; on resume the passed send returns to DRAFT and its approval is superseded", async () => {
    const a = await createAgency("LC10");
    const director = await addMember(a.ctx, "ops_director", "Director");
    const p = await blankProject(a.ctx, "Held gala", { templateIds: [await templateId(a, "vip-digital-campaign")], eventStartAt: new Date(Date.now() + 30 * DAY) });
    const t = await task(a.ctx, p.id, "Overdue seating plan", { ownerId: a.userId, dueAt: new Date(Date.now() - DAY) });
    const rs = await recipients(a, p.id, 2);
    const draft = await adminDb().invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "DIGITAL" } });
    const c = await saveDigitalCampaign(a.ctx, { id: draft.id, projectId: p.id, name: "Gala invitation", channel: "SMS", bodyTemplate: "{{name}} {{rsvp_link}}", rsvpEnabled: true, qrEnabled: false, scheduledAt: new Date(Date.now() + 2 * 3_600_000), version: draft.version });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: rs.map((r) => r.id) });
    const cv = async () => (await adminDb().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).version;
    const appr = await requestCampaignApproval(a.ctx, c.id, await cv());
    await decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
    await launchCampaign(a.ctx, c.id, await cv());
    await setProjectStatus(a.ctx, p.id, "ON_HOLD", { version: await version(p.id), reason: "Client paused the event" });
    // the send time passes during the hold
    await adminDb().invitationCampaign.update({ where: { id: c.id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    await schedulerTick();
    await dispatchDueCampaigns(a.orgId);
    expect(await adminDb().notification.count({ where: { entityId: t.id, type: "task.overdue" } })).toBe(0);
    expect(await adminDb().messageJob.count({ where: { invitation: { campaignId: c.id } } })).toBe(0);
    expect((await adminDb().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("SCHEDULED");
    await setProjectStatus(a.ctx, p.id, "PLANNING", { version: await version(p.id) });
    expect((await adminDb().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("DRAFT");
    expect((await adminDb().approval.findUniqueOrThrow({ where: { id: appr.id } })).status).toBe("SUPERSEDED");
  });
});

describe("§1.1 / §1.5 portal", () => {
  it("LC-11 a legacy AT_RISK project behaves as ACTIVE and the portal never shows 'at risk'", async () => {
    const a = await createAgency("LC11");
    const company = await createClientCompany(a, "Ministry");
    const client = await clientUser(a, company.id);
    const p = await blankProject(a.ctx, "Legacy", { clientId: company.id, eventStartAt: new Date(Date.now() + 10 * DAY) });
    await upsertProjectMember(a.ctx, member(p.id, client.userId, "CLIENT_APPROVER"));
    await adminDb().project.update({ where: { id: p.id }, data: { status: "AT_RISK" } });
    const home = await portalHome(client.ctx);
    expect(home.projects.find((x) => x.id === p.id)?.status).toBe("ACTIVE");
    expect(JSON.stringify(await portalProject(client.ctx, p.id))).not.toMatch(/AT_RISK|atRisk/);
    expect((await setProjectStatus(a.ctx, p.id, "ON_HOLD", { version: await version(p.id), reason: REASON })).status).toBe("ON_HOLD");
  });

  it("LC-12 a cancelled project is a read-only past project in the portal for 180 days, then disappears", async () => {
    const a = await createAgency("LC12");
    const company = await createClientCompany(a, "Ministry");
    const client = await clientUser(a, company.id);
    const p = await blankProject(a.ctx, "Cancelled forum", { clientId: company.id, eventStartAt: new Date(Date.now() + 10 * DAY) });
    await upsertProjectMember(a.ctx, member(p.id, client.userId, "CLIENT_APPROVER"));
    await setProjectStatus(a.ctx, p.id, "CANCELLED", { version: await version(p.id), reason: REASON, notifyClient: true });
    expect(await adminDb().notification.count({ where: { userId: client.userId, title: "projects.lifecycle.notices.cancelledClient" } })).toBe(1);
    const home = await portalHome(client.ctx);
    expect(home.projects.map((x) => x.id)).not.toContain(p.id);
    expect(home.pastProjects.map((x) => x.id)).toContain(p.id);
    const view = await portalProject(client.ctx, p.id);
    expect(view.readOnly).toBe(true);
    expect(view.canApprove).toBe(false);
    await adminDb().project.update({ where: { id: p.id }, data: { statusChangedAt: new Date(Date.now() - 181 * DAY) } });
    expect((await portalHome(client.ctx)).pastProjects.map((x) => x.id)).not.toContain(p.id);
    await expect(portalProject(client.ctx, p.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("§6 concurrent editing on project records", () => {
  it("CE-1 two managers on the same version: the second save is refused with the differing fields ([S3-1])", async () => {
    const a = await createAgency("CE1");
    const { p, pm } = await activeProject(a);
    const loaded = await projectRow(p.id);
    const base = { name: loaded.name, type: "CUSTOM" as const, priority: "MEDIUM" as const, currency: "SAR", clientPortal: true, venueIds: [], eventStartAt: loaded.eventStartAt, version: loaded.version };
    await updateProject(a.ctx, p.id, { ...base, name: "Renamed by A" });
    const err = await updateProject(pm.ctx, p.id, { ...base, description: "B's description" }).catch((e) => e);
    expect(codeOf(err)).toBe("CONFLICT");
    expect((err as { details: { changedFields: string[]; changedBy: { name: string } | null } }).details.changedFields).toContain("name");
    expect((await projectRow(p.id)).name).toBe("Renamed by A");
    await expect(updateProject(pm.ctx, p.id, { ...base, version: undefined })).rejects.toThrow("errors.versionRequired");
  });

  it("CE-3 milestone, risk and deliverable updates without a version are refused", async () => {
    const a = await createAgency("CE3");
    const { p, pm } = await activeProject(a);
    const ms = await saveMilestone(pm.ctx, { projectId: p.id, title: "Venue locked", status: "PENDING", clientVisible: true });
    await expect(saveMilestone(pm.ctx, { id: ms.id, projectId: p.id, title: "Venue locked", status: "IN_PROGRESS", clientVisible: true })).rejects.toThrow("errors.versionRequired");
    const r = await saveRisk(pm.ctx, { projectId: p.id, title: "Rain", likelihood: 2, impact: 3, status: "OPEN" });
    await saveRisk(pm.ctx, { id: r.id, projectId: p.id, title: "Rain", likelihood: 3, impact: 3, status: "OPEN", version: r.version });
    await expect(saveRisk(pm.ctx, { id: r.id, projectId: p.id, title: "Rain", likelihood: 4, impact: 3, status: "OPEN", version: r.version })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("CE rule 5 a bulk update compares each row with the version the user loaded and reports the conflicts", async () => {
    const a = await createAgency("CE bulk");
    const { p, pm } = await activeProject(a);
    const t1 = await task(a.ctx, p.id, "Bulk one");
    const t2 = await task(a.ctx, p.id, "Bulk two");
    const loaded = { [t1.id]: t1.version, [t2.id]: t2.version };
    await updateTask(a.ctx, { id: t2.id, title: "Changed meanwhile", version: t2.version });
    const r = await bulkUpdateTasks(pm.ctx, { projectId: p.id, taskIds: [t1.id, t2.id], versions: loaded, set: { priority: "HIGH" } });
    expect(r.updated).toBe(1);
    expect(r.skipped).toEqual([{ id: t2.id, reason: "errors.staleWrite" }]);
    expect((await adminDb().task.findUniqueOrThrow({ where: { id: t2.id } })).priority).toBe("MEDIUM");
  });

  it("CE-5 a rejection and the automation that reopens the deliverable bump its version, so an open form gets 409", async () => {
    const a = await createAgency("CE5");
    const { p, director, pm } = await activeProject(a);
    const d = await saveDeliverable(pm.ctx, { projectId: p.id, title: "Stage render", status: "IN_PROGRESS", clientVisible: false, requiresApproval: true });
    const appr = await requestApproval(pm.ctx, { projectId: p.id, entityType: "DELIVERABLE", entityId: d.id, title: "Render", approverType: "INTERNAL" });
    const open = await adminDb().deliverable.findUniqueOrThrow({ where: { id: d.id } }); // the form the PM has open
    await decideApproval(director.ctx, { approvalId: appr.id, decision: "REJECTED", comment: "Lighting is wrong" });
    await kickOutbox(a.orgId); // approval.rejected → reopen_entity (automation)
    const now = await adminDb().deliverable.findUniqueOrThrow({ where: { id: d.id } });
    expect(now.version).toBeGreaterThan(open.version);
    await expect(saveDeliverable(pm.ctx, { id: d.id, projectId: p.id, title: "Stage render v2", status: "IN_PROGRESS", clientVisible: false, requiresApproval: true, version: open.version })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
