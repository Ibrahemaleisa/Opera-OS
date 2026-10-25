/**
 * BUSINESS_RULES §6 (concurrent editing) for Stream R's protected records:
 * Recipient, Guest, Booth, Event and InvitationCampaign (physical and digital).
 */
import { describe, expect, it } from "vitest";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { toActionError } from "@/server/action";
import { ConflictError, type ConflictDetails } from "@/server/errors";
import { createProject } from "@/server/modules/projects/service";
import { decideApproval } from "@/server/modules/approvals/service";
import { createRevision, saveBooth, setBoothStage, signHandover } from "@/server/modules/booths/service";
import { createEvent, updateEvent } from "@/server/modules/events/service";
import { assignSeat, saveGuest, saveZone, setAttendance } from "@/server/modules/protocol/service";
import { anonymizeRecipients, saveCampaign, updateRecipient } from "@/server/modules/delivery/service";
import { addAudience, cancelCampaign, checkIn, launchCampaign, requestCampaignApproval, saveDigitalCampaign } from "@/server/modules/digital/service";
import { addMember, createAgency } from "../helpers";

const DAY = 86_400_000;
const BODY = "{{honorific}} {{name}}، يسرنا دعوتكم. للتأكيد: {{rsvp_link}}";

/** Resolves to the rejection of `p` (fails the test when `p` resolves). */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the write to be refused");
}
async function conflictOf(p: Promise<unknown>): Promise<ConflictDetails> {
  const e = await rejection(p);
  expect(e).toBeInstanceOf(ConflictError);
  expect((e as ConflictError).message).toBe("errors.staleWrite");
  expect((e as ConflictError).status).toBe(409);
  return (e as ConflictError).details!;
}

async function setup(name: string, templates: string[], type = "EVENT") {
  const a = await createAgency(name);
  const b = await addMember(a.ctx, "ops_director", "Director B");
  const tpl = (key: string) => withTenant({ orgId: a.orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key } } })).id);
  const { project } = await createProject(a.ctx, { name: `${name} project`, type: type as never, priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: await Promise.all(templates.map(tpl)), eventStartAt: new Date(Date.now() + 30 * DAY) });
  return { a, b, project };
}

const recipient = (orgId: string, projectId: string, userId: string, code: string, extra: Record<string, unknown> = {}) =>
  withTenant({ orgId }, (tx) => tx.recipient.create({ data: { organizationId: orgId, projectId, createdById: userId, code, nameAr: `ضيف ${code}`, mobile: `+9665550${code.slice(-5)}`, ...extra } }));

describe("CE-3 · updates and status transitions without a version are refused (Stream R records)", () => {
  it("CE-3 refuses Recipient, Guest, Event, Booth and campaign writes without a version, and writes nothing", async () => {
    const { a, project } = await setup("CE3 ops", ["vip-digital-campaign", "corporate-event"]);
    const required = "errors.versionRequired";

    const r = await recipient(a.orgId, project.id, a.userId, "R-00001");
    await expect(updateRecipient(a.ctx, { id: r.id, nameEn: "Changed" })).rejects.toThrow(required);

    const g = await saveGuest(a.ctx, { projectId: project.id, nameAr: "ضيف المراسم", category: "VIP", protocolLevel: 2 });
    await expect(saveGuest(a.ctx, { id: g.id, projectId: project.id, nameAr: "ضيف المراسم", category: "VIP", protocolLevel: 2, title: "Changed" })).rejects.toThrow(required);
    await expect(setAttendance(a.ctx, { guestId: g.id, attendance: "CONFIRMED" })).rejects.toThrow(required);
    await expect(assignSeat(a.ctx, { guestId: g.id, seatZoneId: null })).rejects.toThrow(required);

    const ev = await createEvent(a.ctx, { projectId: project.id, name: "Gala night", startsAt: new Date(Date.now() + 20 * DAY), endsAt: new Date(Date.now() + 20 * DAY + 4 * 3600_000) });
    await expect(updateEvent(a.ctx, { id: ev.id, name: "Changed", startsAt: ev.startsAt, endsAt: ev.endsAt, phase: "SETUP" })).rejects.toThrow(required);

    const booth = await saveBooth(a.ctx, { projectId: project.id, name: "Stand A", kind: "BOOTH", permitStatus: "NOT_STARTED" });
    await expect(saveBooth(a.ctx, { id: booth.id, projectId: project.id, name: "Changed", kind: "BOOTH", permitStatus: "NOT_STARTED" })).rejects.toThrow(required);
    await expect(setBoothStage(a.ctx, { boothId: booth.id, stage: "DESIGN" })).rejects.toThrow(required);

    const physical = await saveCampaign(a.ctx, { projectId: project.id, name: "Hand delivery", requireEvidence: true, requireReceiverName: true, maxAttempts: 3 });
    await expect(saveCampaign(a.ctx, { id: physical.id, projectId: project.id, name: "Changed", requireEvidence: true, requireReceiverName: true, maxAttempts: 3 })).rejects.toThrow(required);

    const draft = await adminDb().invitationCampaign.findFirstOrThrow({ where: { projectId: project.id, type: "DIGITAL" } });
    await expect(saveDigitalCampaign(a.ctx, { id: draft.id, projectId: project.id, name: "Changed", channel: "SMS", bodyTemplate: BODY, rsvpEnabled: true, qrEnabled: false })).rejects.toThrow(required);
    const c = await saveDigitalCampaign(a.ctx, { id: draft.id, version: draft.version, projectId: project.id, name: "Invite", channel: "SMS", bodyTemplate: BODY, rsvpEnabled: true, qrEnabled: false });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [r.id] });
    await addMember(a.ctx, "ops_director", "Approver");
    await expect(requestCampaignApproval(a.ctx, c.id)).rejects.toThrow(required);
    await expect(cancelCampaign(a.ctx, c.id)).rejects.toThrow(required);

    // nothing was written by any refused call
    const db = adminDb();
    expect(await db.recipient.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ nameEn: null, version: 0 });
    expect(await db.guest.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ title: null, attendance: "EXPECTED", version: 0 });
    expect(await db.event.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ name: "Gala night", phase: "PLANNING", version: 0 });
    expect(await db.booth.findUniqueOrThrow({ where: { id: booth.id } })).toMatchObject({ name: "Stand A", stage: "BRIEF", version: 0 });
    expect(await db.invitationCampaign.findUniqueOrThrow({ where: { id: physical.id } })).toMatchObject({ name: "Hand delivery", version: 0 });
    expect(await db.invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ name: "Invite", status: "DRAFT" });
  });
});

describe("CE-1 / CE-2 · stale writes conflict, re-apply mine writes only my change (Stream R records)", () => {
  it("CE-1 a stale guest save gets 409 with the differing fields and who saved; CE-2 re-applying writes only mine at the next version", async () => {
    const { a, b, project } = await setup("CE1 guest", ["corporate-event"]);
    const g = await saveGuest(a.ctx, { projectId: project.id, nameAr: "معالي الضيف", category: "VVIP", protocolLevel: 1, restrictedNotes: "Arrives via the private gate" });
    const form = { id: g.id, projectId: project.id, nameAr: g.nameAr, nameEn: null, honorific: null, title: null, organizationName: null, category: "VVIP" as const, protocolLevel: g.protocolLevel, arrivalPoint: null, specialInstructions: null };
    // A and B both loaded version 0; A saves a title first
    await saveGuest(a.ctx, { ...form, title: "Minister", version: 0 });
    // B saves an arrival point from the stale form
    const d = await conflictOf(saveGuest(b.ctx, { ...form, arrivalPoint: "Gate 3", version: 0 }));
    expect(d.changedFields).toContain("title");
    expect(d.current).toMatchObject({ id: g.id, version: 1, title: "Minister", arrivalPoint: null });
    expect(d.changedBy?.name).toBe(a.ctx.userName);
    expect(Date.now() - new Date(d.changedBy!.at).getTime()).toBeLessThan(60_000);
    // the conflict never echoes restricted notes (they are only shown through the audited reveal)
    expect(d.current).not.toHaveProperty("restrictedNotes");
    // nothing was written
    expect(await adminDb().guest.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ title: "Minister", arrivalPoint: null, version: 1 });

    // the action layer returns the details as ActionResult.conflict
    const res = toActionError(await rejection(saveGuest(b.ctx, { ...form, arrivalPoint: "Gate 3", version: 0 })));
    expect(res).toMatchObject({ ok: false, code: "CONFLICT", error: "errors.staleWrite", conflict: { changedFields: expect.arrayContaining(["title"]) } });

    // CE-2: B re-applies only the field B changed, on top of the stored values, at the new version
    await saveGuest(b.ctx, { ...form, title: d.current.title as string, arrivalPoint: "Gate 3", version: d.current.version as number });
    const after = await adminDb().guest.findUniqueOrThrow({ where: { id: g.id } });
    expect(after).toMatchObject({ title: "Minister", arrivalPoint: "Gate 3", version: 2, restrictedNotes: "Arrives via the private gate" });
  });

  it("CE-1 / CE-2 for a recipient patch: only my fields are re-sent, the other editor's change stays", async () => {
    const { a, b, project } = await setup("CE1 recipient", ["corporate-event"]);
    const r = await recipient(a.orgId, project.id, a.userId, "R-00002");
    await updateRecipient(a.ctx, { id: r.id, nameEn: "H.E. Guest", version: 0 });
    const d = await conflictOf(updateRecipient(b.ctx, { id: r.id, jobTitle: "Ambassador", version: 0 }));
    expect(d.current).toMatchObject({ version: 1, jobTitle: null });
    expect(d.changedBy?.name).toBe(a.ctx.userName);
    expect(await adminDb().recipient.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ nameEn: "H.E. Guest", jobTitle: null, version: 1 });
    await updateRecipient(b.ctx, { id: r.id, jobTitle: "Ambassador", version: d.current.version as number });
    expect(await adminDb().recipient.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ nameEn: "H.E. Guest", jobTitle: "Ambassador", version: 2 });
  });

  it("CE-1 / CE-2 for an event: a stale rename conflicts on the phase another manager changed", async () => {
    const { a, b, project } = await setup("CE1 event", ["corporate-event"]);
    const ev = await createEvent(a.ctx, { projectId: project.id, name: "Opening", startsAt: new Date(Date.now() + 10 * DAY), endsAt: new Date(Date.now() + 10 * DAY + 3 * 3600_000) });
    const form = { id: ev.id, name: ev.name, startsAt: ev.startsAt, endsAt: ev.endsAt, phase: ev.phase, venueId: null, expectedGuests: null, brief: null };
    await updateEvent(a.ctx, { ...form, phase: "SETUP", version: 0 });
    const d = await conflictOf(updateEvent(b.ctx, { ...form, name: "Grand opening", version: 0 }));
    expect(d.changedFields).toContain("phase");
    expect(d.current).toMatchObject({ phase: "SETUP", name: "Opening", version: 1 });
    expect(await adminDb().event.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ name: "Opening", phase: "SETUP" });
    await updateEvent(b.ctx, { ...form, phase: d.current.phase as "SETUP", name: "Grand opening", version: d.current.version as number });
    expect(await adminDb().event.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ name: "Grand opening", phase: "SETUP", version: 2 });
  });

  it("CE-1 for booths, seating and the physical campaign: a stale write is refused and changes nothing", async () => {
    const { a, b, project } = await setup("CE1 booth", ["corporate-event"]);
    const booth = await saveBooth(a.ctx, { projectId: project.id, name: "Stand B", kind: "BOOTH", permitStatus: "NOT_STARTED" });
    const form = { id: booth.id, projectId: project.id, name: booth.name, kind: "BOOTH" as const, permitStatus: "NOT_STARTED" as const };
    await saveBooth(a.ctx, { ...form, permitStatus: "SUBMITTED", version: 0 });
    const d = await conflictOf(saveBooth(b.ctx, { ...form, name: "Stand B (corner)", version: 0 }));
    expect(d.changedFields).toContain("permitStatus");
    expect(await adminDb().booth.findUniqueOrThrow({ where: { id: booth.id } })).toMatchObject({ name: "Stand B", permitStatus: "SUBMITTED", version: 1 });
    // a stale one-click stage move and handover are refused too
    await conflictOf(setBoothStage(b.ctx, { boothId: booth.id, stage: "DESIGN", version: 0 }));
    await conflictOf(signHandover(b.ctx, { boothId: booth.id, signedBy: "Client rep", version: 0 }));

    const ev = await createEvent(a.ctx, { projectId: project.id, name: "Dinner", startsAt: new Date(Date.now() + 10 * DAY), endsAt: new Date(Date.now() + 10 * DAY + 3 * 3600_000) });
    const zone = await saveZone(a.ctx, { eventId: ev.id, name: "Front", capacity: 10 });
    const g = await saveGuest(a.ctx, { projectId: project.id, eventId: ev.id, nameAr: "ضيف", category: "VIP", protocolLevel: 2 });
    await assignSeat(a.ctx, { guestId: g.id, seatZoneId: zone.id, seatLabel: "A1", version: 0 });
    await conflictOf(assignSeat(b.ctx, { guestId: g.id, seatZoneId: zone.id, seatLabel: "A2", version: 0 }));
    expect(await adminDb().guest.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ seatLabel: "A1", version: 1 });

    const camp = await saveCampaign(a.ctx, { projectId: project.id, name: "Couriers", requireEvidence: true, requireReceiverName: true, maxAttempts: 3 });
    await saveCampaign(a.ctx, { id: camp.id, projectId: project.id, name: "Couriers", requireEvidence: true, requireReceiverName: true, maxAttempts: 5, version: 0 });
    await conflictOf(saveCampaign(b.ctx, { id: camp.id, projectId: project.id, name: "Couriers (VIP)", requireEvidence: true, requireReceiverName: true, maxAttempts: 3, version: 0 }));
    expect(await adminDb().invitationCampaign.findUniqueOrThrow({ where: { id: camp.id } })).toMatchObject({ name: "Couriers", version: 1 });
  });
});

describe("CE-5 · system and automation writes bump the version (Stream R records)", () => {
  it("CE-5 a design revision, a door scan, an erasure and a dispatch each make an open form stale", async () => {
    const { a, b, project } = await setup("CE5 ops", ["vip-digital-campaign", "corporate-event"]);
    // booth: starting a design revision moves BRIEF → DESIGN (system write)
    const booth = await saveBooth(a.ctx, { projectId: project.id, name: "Stand C", kind: "BOOTH", permitStatus: "NOT_STARTED" });
    await createRevision(a.ctx, { boothId: booth.id, title: "Concept" });
    expect(await adminDb().booth.findUniqueOrThrow({ where: { id: booth.id } })).toMatchObject({ stage: "DESIGN", version: 1 });
    await conflictOf(saveBooth(b.ctx, { id: booth.id, projectId: project.id, name: "Stand C2", kind: "BOOTH", permitStatus: "NOT_STARTED", version: 0 }));

    // digital campaign approved, launched and dispatched inline: the sender's SENDING → ACTIVE bumps the version
    const r1 = await recipient(a.orgId, project.id, a.userId, "R-00011");
    const r2 = await recipient(a.orgId, project.id, a.userId, "R-00012");
    const draft = await adminDb().invitationCampaign.findFirstOrThrow({ where: { projectId: project.id, type: "DIGITAL" } });
    const c = await saveDigitalCampaign(a.ctx, { id: draft.id, version: draft.version, projectId: project.id, name: "Invite", channel: "SMS", bodyTemplate: BODY, rsvpEnabled: true, qrEnabled: true });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [r1.id, r2.id] });
    const ver = async () => (await adminDb().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).version;
    const appr = await requestCampaignApproval(a.ctx, c.id, await ver());
    await decideApproval(b.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
    const beforeLaunch = await ver();
    await launchCampaign(a.ctx, c.id, beforeLaunch);
    const afterLaunch = await adminDb().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(afterLaunch.status).toBe("ACTIVE");
    expect(afterLaunch.version).toBeGreaterThan(beforeLaunch + 1); // the user's CAS, then the sender's
    await conflictOf(cancelCampaign(a.ctx, c.id, beforeLaunch + 1));

    // guest: a QR scan at the door marks the linked guest ARRIVED; the protocol desk's open board is stale
    const g = await saveGuest(a.ctx, { projectId: project.id, nameAr: "ضيف مرتبط", category: "VIP", protocolLevel: 2 });
    await withTenant({ orgId: a.orgId }, (tx) => tx.guest.update({ where: { id: g.id }, data: { recipientId: r1.id } }));
    const inv = await adminDb().digitalInvitation.findFirstOrThrow({ where: { campaignId: c.id, recipientId: r1.id } });
    await checkIn(a.ctx, { campaignId: c.id, code: inv.qrCode! });
    expect(await adminDb().guest.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ attendance: "ARRIVED", version: 1 });
    await conflictOf(setAttendance(b.ctx, { guestId: g.id, attendance: "NO_SHOW", version: 0 }));

    // recipient: an erasure bumps the version, so a form opened before it can't write back personal data
    const r3 = await recipient(a.orgId, project.id, a.userId, "R-00013");
    await anonymizeRecipients(a.ctx, { projectId: project.id, recipientIds: [r3.id] });
    await conflictOf(updateRecipient(a.ctx, { id: r3.id, nameAr: "Re-identified", version: 0 }));
    expect(await adminDb().recipient.findUniqueOrThrow({ where: { id: r3.id } })).toMatchObject({ nameAr: null, version: 1 });
  });

  it("CE campaign approval binding: an edit during approval voids it, and a launch from the page loaded before the edit conflicts", async () => {
    const { a, b, project } = await setup("CE bind", ["vip-digital-campaign", "corporate-event"]);
    const r = await recipient(a.orgId, project.id, a.userId, "R-00021");
    const draft = await adminDb().invitationCampaign.findFirstOrThrow({ where: { projectId: project.id, type: "DIGITAL" } });
    const c = await saveDigitalCampaign(a.ctx, { id: draft.id, version: draft.version, projectId: project.id, name: "Invite", channel: "SMS", bodyTemplate: BODY, rsvpEnabled: true, qrEnabled: false });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [r.id] });
    const ver = async () => (await adminDb().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).version;
    const appr = await requestCampaignApproval(a.ctx, c.id, await ver());
    await decideApproval(b.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
    const approvedAt = await ver(); // the launcher's page
    const edited = await saveDigitalCampaign(a.ctx, { id: c.id, version: approvedAt, projectId: project.id, name: "Invite", channel: "SMS", bodyTemplate: `${BODY} (edited)`, rsvpEnabled: true, qrEnabled: false });
    expect((edited as { approvalInvalidated?: boolean }).approvalInvalidated).toBe(true);
    expect(edited.status).toBe("DRAFT");
    await conflictOf(launchCampaign(a.ctx, c.id, approvedAt));
    await expect(launchCampaign(a.ctx, c.id, await ver())).rejects.toThrow("errors.campaignNotApproved");
    expect(await adminDb().messageJob.count({ where: { invitation: { campaignId: c.id } } })).toBe(0);
  });
});
