/**
 * BUSINESS_RULES §1.3 / §1.5 / §1.6 in Stream R's services: what still works in archived (CLOSED /
 * CANCELLED) and paused (ON_HOLD) projects. Project states are seeded directly: the lifecycle path
 * that sets them is Stream L's and is tested there.
 */
import { describe, expect, it } from "vitest";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { createProject } from "@/server/modules/projects/service";
import { decideApproval } from "@/server/modules/approvals/service";
import { createEvent, getEventWorkspace, reportIncident, saveShift, updateEvent, updateIncident } from "@/server/modules/events/service";
import { saveGuest } from "@/server/modules/protocol/service";
import { saveBooth } from "@/server/modules/booths/service";
import { bulkAssign, createBatch, generateDeliveries, saveCampaign, updateDeliveryStatus, anonymizeRecipients } from "@/server/modules/delivery/service";
import { configureAndValidate, createImport, importStatus, listImportRows } from "@/server/modules/delivery/imports/service";
import { addAudience, checkIn, getRsvpPage, launchCampaign, requestCampaignApproval, saveDigitalCampaign, submitRsvp } from "@/server/modules/digital/service";
import { dispatchCampaign } from "@/server/modules/digital/sender";
import { recoverStalledWork, systemHealth } from "@/server/modules/recovery/service";
import { createWorkOrder, saveVendor, setWorkOrderStatus } from "@/server/modules/vendors/service";
import { addMember, createAgency } from "../helpers";

const DAY = 86_400_000;
const MIN = 60_000;
const BODY = "{{honorific}} {{name}}، يسرنا دعوتكم. للتأكيد: {{rsvp_link}}";
const db = () => adminDb();
type Agency = Awaited<ReturnType<typeof createAgency>>;

let shared: Promise<Agency & { director: Awaited<ReturnType<typeof addMember>>; agent: Awaited<ReturnType<typeof addMember>> }> | null = null;
const agency = () =>
  (shared ??= createAgency("Archived ops").then(async (a) => ({ ...a, director: await addMember(a.ctx, "ops_director", "Director"), agent: await addMember(a.ctx, "field_agent", "Driver") })));

async function project(a: Agency, templates: string[], type = "EVENT") {
  const tpl = (key: string) => withTenant({ orgId: a.orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key } } })).id);
  const { project } = await createProject(a.ctx, { name: "Archive rules", type: type as never, priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: await Promise.all(templates.map(tpl)), eventStartAt: new Date(Date.now() + 30 * DAY) });
  return project;
}
const setStatus = (projectId: string, status: "CANCELLED" | "CLOSED" | "ON_HOLD") => db().project.update({ where: { id: projectId }, data: { status, ...(status === "ON_HOLD" ? {} : { archivedAt: new Date() }) } });

describe("§1.5 archived projects in Stream R services", () => {
  it("LC rule 5 incidents stay operable (status, owner, resolution) while every other edit is refused with errors.projectArchived", async () => {
    const a = await agency();
    const p = await project(a, ["corporate-event"]);
    const ev = await createEvent(a.ctx, { projectId: p.id, name: "Opening", startsAt: new Date(Date.now() + 5 * DAY), endsAt: new Date(Date.now() + 5 * DAY + 3 * 3600_000) });
    const inc = await reportIncident(a.ctx, { projectId: p.id, eventId: ev.id, title: "Generator fault", severity: "HIGH" });
    const g = await saveGuest(a.ctx, { projectId: p.id, nameAr: "ضيف", category: "VIP", protocolLevel: 2 });
    const booth = await saveBooth(a.ctx, { projectId: p.id, name: "Stand", kind: "BOOTH", permitStatus: "NOT_STARTED" });
    await setStatus(p.id, "CANCELLED");

    await updateIncident(a.ctx, { id: inc.id, status: "ACKNOWLEDGED" });
    await updateIncident(a.ctx, { id: inc.id, ownerId: a.director.userId });
    await updateIncident(a.ctx, { id: inc.id, status: "RESOLVED", resolution: "Backup generator on site" });
    expect(await db().incident.findUniqueOrThrow({ where: { id: inc.id } })).toMatchObject({ status: "RESOLVED", ownerId: a.director.userId });
    await expect(updateIncident(a.ctx, { id: inc.id, escalate: true })).rejects.toThrow("errors.projectArchived");
    await expect(reportIncident(a.ctx, { projectId: p.id, title: "New issue", severity: "LOW" })).rejects.toThrow("errors.projectArchived");

    await expect(updateEvent(a.ctx, { id: ev.id, name: "Renamed", startsAt: ev.startsAt, endsAt: ev.endsAt, phase: "SETUP", version: ev.version })).rejects.toThrow("errors.projectArchived");
    await expect(saveGuest(a.ctx, { id: g.id, projectId: p.id, nameAr: "ضيف", category: "VIP", protocolLevel: 1, version: g.version })).rejects.toThrow("errors.projectArchived");
    await expect(saveBooth(a.ctx, { id: booth.id, projectId: p.id, name: "Stand 2", kind: "BOOTH", permitStatus: "NOT_STARTED", version: booth.version })).rejects.toThrow("errors.projectArchived");

    const w = await getEventWorkspace(a.ctx, ev.id);
    expect({ canManage: w.canManage, canReport: w.canReport, canHandleIncidents: w.canHandleIncidents, archived: w.archived }).toEqual({ canManage: false, canReport: false, canHandleIncidents: true, archived: true });
  });

  it("§1.3 in an archived project an in-car delivery may only become RETURNED or DELIVERED, dispatch may close RETURNED → CANCELLED, and CANCELLED → READY is refused", async () => {
    const a = await agency();
    const p = await project(a, ["vip-physical-delivery"], "VIP_DELIVERY");
    const campaign = await db().invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "PHYSICAL" } });
    await db().invitationCampaign.update({ where: { id: campaign.id }, data: { config: { requireEvidence: false, requireReceiverName: true, maxAttempts: 3 } } });
    const rs = await withTenant({ orgId: a.orgId }, (tx) => Promise.all([1, 2, 3].map((i) => tx.recipient.create({ data: { organizationId: a.orgId, projectId: p.id, createdById: a.userId, code: `R-0000${i}`, nameAr: `ضيف ${i}`, mobile: `+96655540000${i}`, address: "حي الملقا", city: "الرياض" } }))));
    await generateDeliveries(a.ctx, { campaignId: campaign.id, recipientIds: rs.map((r) => r.id) });
    const [d1, d2, d3] = await db().delivery.findMany({ where: { campaignId: campaign.id }, orderBy: { trackingCode: "asc" } });
    await db().delivery.updateMany({ where: { id: { in: [d1.id, d2.id] } }, data: { status: "OUT_FOR_DELIVERY", agentId: a.userId } });
    await db().delivery.update({ where: { id: d3.id }, data: { status: "CANCELLED" } });
    await setStatus(p.id, "CANCELLED");
    const v = async (id: string) => (await db().delivery.findUniqueOrThrow({ where: { id } })).version;

    await expect(updateDeliveryStatus(a.ctx, { deliveryId: d1.id, to: "FAILED_ATTEMPT", reason: "NO_ANSWER", version: await v(d1.id), evidenceIds: [], source: "WEB" })).rejects.toThrow("errors.archivedOutForDelivery");
    await expect(updateDeliveryStatus(a.ctx, { deliveryId: d1.id, to: "RESCHEDULED", scheduledFor: new Date(Date.now() + DAY), version: await v(d1.id), evidenceIds: [], source: "WEB" })).rejects.toThrow("errors.archivedOutForDelivery");
    await updateDeliveryStatus(a.ctx, { deliveryId: d1.id, to: "RETURNED", reason: "OTHER", version: await v(d1.id), evidenceIds: [], source: "WEB" });
    await updateDeliveryStatus(a.ctx, { deliveryId: d1.id, to: "CANCELLED", version: await v(d1.id), evidenceIds: [], source: "WEB" });
    await updateDeliveryStatus(a.ctx, { deliveryId: d2.id, to: "DELIVERED", receivedByName: "مدير المكتب", version: await v(d2.id), evidenceIds: [], source: "WEB" });
    await expect(updateDeliveryStatus(a.ctx, { deliveryId: d3.id, to: "READY", version: await v(d3.id), evidenceIds: [], source: "WEB" })).rejects.toThrow("errors.archivedNoReopen");
    expect((await db().delivery.findMany({ where: { id: { in: [d1.id, d2.id, d3.id] } }, orderBy: { trackingCode: "asc" } })).map((d) => d.status)).toEqual(["CANCELLED", "DELIVERED", "CANCELLED"]);

    await expect(bulkAssign(a.ctx, { projectId: p.id, deliveryIds: [d3.id], agentId: a.agent.userId, overrideCapacity: false })).rejects.toThrow("errors.projectArchived");
    await expect(saveCampaign(a.ctx, { projectId: p.id, name: "New", requireEvidence: true, requireReceiverName: true, maxAttempts: 3 })).rejects.toThrow("errors.projectArchived");
    // PDPL erasure stays available in an archived project
    await expect(anonymizeRecipients(a.ctx, { projectId: p.id, recipientIds: [rs[2].id] })).resolves.toEqual({ anonymized: 1 });
  });

  it("§1.3 the RSVP link of a cancelled project's campaign says only that it is no longer active, and takes no responses or check-ins", async () => {
    const a = await agency();
    const p = await project(a, ["vip-digital-campaign", "corporate-event"]);
    const r = await withTenant({ orgId: a.orgId }, (tx) => tx.recipient.create({ data: { organizationId: a.orgId, projectId: p.id, createdById: a.userId, code: "R-00001", nameAr: "ضيف", mobile: "+966555410001" } }));
    const draft = await db().invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "DIGITAL" } });
    const c = await saveDigitalCampaign(a.ctx, { id: draft.id, version: draft.version, projectId: p.id, name: "Gala", channel: "SMS", bodyTemplate: BODY, rsvpEnabled: true, qrEnabled: true });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [r.id] });
    const ver = async () => (await db().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).version;
    const appr = await requestCampaignApproval(a.ctx, c.id, await ver());
    await decideApproval(a.director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
    await launchCampaign(a.ctx, c.id, await ver());
    const job = await db().messageJob.findFirstOrThrow({ where: { invitation: { campaignId: c.id } } });
    const token = /\/rsvp\/([A-Za-z0-9_-]+)/.exec(job.body)![1];
    expect(await getRsvpPage(token)).toMatchObject({ inactive: false, event: { name: expect.any(String) } });
    await submitRsvp({ token, response: "ATTENDING", guestsCount: 1 }, "127.0.0.9");
    const qr = (await db().digitalInvitation.findFirstOrThrow({ where: { campaignId: c.id } })).qrCode!;

    await setStatus(p.id, "CANCELLED"); // the campaign itself stays ACTIVE (already sent)
    const page = await getRsvpPage(token);
    expect(page).toMatchObject({ inactive: true, closed: true, event: null, qrCode: null, rsvpStatus: null, campaign: { name: null } });
    await expect(submitRsvp({ token, response: "DECLINED", guestsCount: 1 }, "127.0.0.9")).rejects.toThrow("errors.tokenInvalid");
    await expect(checkIn(a.ctx, { campaignId: c.id, code: qr })).rejects.toThrow("errors.projectArchived");
    expect((await db().digitalInvitation.findFirstOrThrow({ where: { campaignId: c.id } })).rsvpStatus).toBe("ATTENDING");
  });

  it("§1.5 work orders keep the financial tail (agency accept / cancel) and imports stay readable", async () => {
    const a = await agency();
    const p = await project(a, ["vip-physical-delivery"], "VIP_DELIVERY");
    const vendor = await saveVendor(a.ctx, { name: "ورشة الاختبار", category: "FABRICATION", status: "ACTIVE" });
    const wo = await createWorkOrder(a.ctx, { projectId: p.id, vendorId: vendor.id, title: "Signage" });
    const wo2 = await createWorkOrder(a.ctx, { projectId: p.id, vendorId: vendor.id, title: "Banners" });
    await db().workOrder.update({ where: { id: wo.id }, data: { status: "DELIVERED" } });
    await db().workOrder.update({ where: { id: wo2.id }, data: { status: "DELIVERED" } });
    const batch = await createImport(a.ctx, { projectId: p.id, campaignId: null, fileName: "l.csv", declaredType: "text/csv", body: Buffer.from("الاسم,الجوال,العنوان,المدينة\nضيف,0551231234,حي,الرياض\n") });
    await configureAndValidate(a.ctx, { batchId: batch.id, sheetName: batch.sheetName!, headerRow: batch.headerRow, mapping: { nameAr: "الاسم", mobile: "الجوال", address: "العنوان", city: "المدينة" }, options: { duplicateScope: "PROJECT", matchOn: ["mobile"], requireMobile: true, requireLocation: true } });
    await setStatus(p.id, "CLOSED");

    await expect(setWorkOrderStatus(a.ctx, { id: wo.id, status: "IN_PROGRESS" })).rejects.toThrow("errors.projectArchived");
    await expect(setWorkOrderStatus(a.ctx, { id: wo.id, status: "ACCEPTED_BY_AGENCY", rating: 4 })).resolves.toEqual({ status: "ACCEPTED_BY_AGENCY" });
    await expect(setWorkOrderStatus(a.ctx, { id: wo2.id, status: "CANCELLED" })).rejects.toThrow("errors.invalidTransition"); // DELIVERED can't be cancelled (unchanged flow)
    await expect(createWorkOrder(a.ctx, { projectId: p.id, vendorId: vendor.id, title: "More" })).rejects.toThrow("errors.projectArchived");

    expect((await importStatus(a.ctx, batch.id)).status).toBe("VALIDATED");
    expect((await listImportRows(a.ctx, batch.id)).rows).toHaveLength(1);
    await expect(configureAndValidate(a.ctx, { batchId: batch.id, sheetName: batch.sheetName!, headerRow: batch.headerRow, mapping: { nameAr: "الاسم" }, options: { duplicateScope: "PROJECT", matchOn: ["mobile"], requireMobile: true, requireLocation: true } })).rejects.toThrow("errors.projectArchived");
  });
});

describe("§1.6 on-hold projects in Stream R services", () => {
  it("§1.6 an on-hold project takes no new assignments, batches or shifts, and its passed scheduled send is held, not reported late", async () => {
    const a = await agency();
    const p = await project(a, ["vip-physical-delivery", "vip-digital-campaign", "corporate-event"], "EVENT");
    const physical = await db().invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "PHYSICAL" } });
    const r = await withTenant({ orgId: a.orgId }, (tx) => tx.recipient.create({ data: { organizationId: a.orgId, projectId: p.id, createdById: a.userId, code: "R-00001", nameAr: "ضيف", mobile: "+966555420001", address: "حي", city: "الرياض" } }));
    await generateDeliveries(a.ctx, { campaignId: physical.id, recipientIds: [r.id] });
    const d = await db().delivery.findFirstOrThrow({ where: { campaignId: physical.id } });
    const ev = await createEvent(a.ctx, { projectId: p.id, name: "Dinner", startsAt: new Date(Date.now() + 5 * DAY), endsAt: new Date(Date.now() + 5 * DAY + 3600_000) });
    // an approved campaign scheduled for later, launched before the hold
    const draft = await db().invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "DIGITAL" } });
    const c = await saveDigitalCampaign(a.ctx, { id: draft.id, version: draft.version, projectId: p.id, name: "Gala", channel: "SMS", bodyTemplate: BODY, rsvpEnabled: true, qrEnabled: false, scheduledAt: new Date(Date.now() + 2 * DAY) });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [r.id] });
    const ver = async () => (await db().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).version;
    const appr = await requestCampaignApproval(a.ctx, c.id, await ver());
    await decideApproval(a.director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
    expect((await launchCampaign(a.ctx, c.id, await ver())).status).toBe("SCHEDULED");

    await setStatus(p.id, "ON_HOLD");
    await expect(bulkAssign(a.ctx, { projectId: p.id, deliveryIds: [d.id], agentId: a.agent.userId, overrideCapacity: false })).rejects.toThrow("errors.projectNotRunning");
    await expect(createBatch(a.ctx, { projectId: p.id, campaignId: physical.id, name: "North", deliveryIds: [] })).rejects.toThrow("errors.projectNotRunning");
    await expect(saveShift(a.ctx, { eventId: ev.id, role: "Usher", startsAt: ev.startsAt, endsAt: ev.endsAt })).rejects.toThrow("errors.projectNotRunning");

    // the send time passes during the hold: nothing is sent, and it is not "late" (LC rule 8 handles it on resume)
    await db().invitationCampaign.update({ where: { id: c.id }, data: { scheduledAt: new Date(Date.now() - 45 * MIN) } });
    expect(await dispatchCampaign(a.orgId, a.userId, c.id)).toMatchObject({ queued: 0 });
    expect((await recoverStalledWork(a.orgId)).held).toBe(0);
    expect((await db().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("SCHEDULED");
    expect(await db().messageJob.count({ where: { invitation: { campaignId: c.id } } })).toBe(0);
    expect(await db().notification.count({ where: { type: "campaign.held_late", entityId: c.id } })).toBe(0);
    expect((await systemHealth(a.ctx)).stalled.sends.map((s) => s.id)).not.toContain(c.id);
  });
});
