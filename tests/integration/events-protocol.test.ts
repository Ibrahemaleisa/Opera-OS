import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { adminDb } from "@/server/db/admin";
import { createProject } from "@/server/modules/projects/service";
import { commandCenter, getEventWorkspace, reportIncident, saveRunItem, saveShift, saveSpeaker, setReadinessStatus, setRunItemStatus, updateIncident } from "@/server/modules/events/service";
import { arrivalsBoard, assignSeat, importGuestsFromRecipients, listGuests, revealRestrictedNotes, saveGuest, saveZone, setAttendance } from "@/server/modules/protocol/service";
import { addMember, createAgency } from "../helpers";

async function setup() {
  const a = await createAgency("Events");
  const tpl = (key: string) => withTenant({ orgId: a.orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key } } })).id);
  const startsAt = new Date(Date.now() + 3600_000);
  const { project } = await createProject(a.ctx, { name: "Summit", type: "CONFERENCE", priority: "HIGH", currency: "SAR", clientPortal: false, venueIds: [], templateIds: [await tpl("conference"), await tpl("vip-protocol")], eventStartAt: startsAt });
  const event = await withTenant({ orgId: a.orgId }, (tx) => tx.event.findFirstOrThrow({ where: { projectId: project.id } }));
  return { a, project, event };
}

describe("events & conference operations", () => {
  it("readiness, run of show cues, shift clashes, incident lifecycle and command center", async () => {
    const { a, project, event } = await setup();
    let ws = await getEventWorkspace(a.ctx, event.id);
    expect(ws.readiness.length).toBeGreaterThanOrEqual(7); // default checklist from template
    expect(ws.readinessScore).toBe(0);

    await expect(setReadinessStatus(a.ctx, { id: ws.readiness[0].id, status: "ISSUE" })).rejects.toThrow("errors.validation");
    await setReadinessStatus(a.ctx, { id: ws.readiness[0].id, status: "READY" });

    const c1 = await saveRunItem(a.ctx, { eventId: event.id, startsAt: event.startsAt, durationMin: 10, title: "Opening video" });
    const c2 = await saveRunItem(a.ctx, { eventId: event.id, startsAt: new Date(event.startsAt.getTime() + 600_000), durationMin: 20, title: "Welcome speech" });
    await setRunItemStatus(a.ctx, { id: c1.id, status: "GO", expected: "PENDING" });
    await expect(setRunItemStatus(a.ctx, { id: c1.id, status: "GO", expected: "PENDING" })).rejects.toThrow(); // stale operator
    await setRunItemStatus(a.ctx, { id: c2.id, status: "GO" });
    ws = await getEventWorkspace(a.ctx, event.id);
    expect(ws.runOfShow.find((r) => r.id === c1.id)?.status).toBe("DONE"); // only one live cue
    expect(ws.current?.id).toBe(c2.id);

    const staff = await addMember(a.ctx, "employee", "Usher");
    await saveShift(a.ctx, { eventId: event.id, userId: staff.userId, role: "Usher", startsAt: event.startsAt, endsAt: new Date(event.startsAt.getTime() + 4 * 3600_000) });
    await expect(saveShift(a.ctx, { eventId: event.id, userId: staff.userId, role: "Usher", startsAt: new Date(event.startsAt.getTime() + 3600_000), endsAt: new Date(event.startsAt.getTime() + 5 * 3600_000) })).rejects.toThrow("errors.validation");

    // speakers: contact masked for users without VIP scope
    await saveSpeaker(a.ctx, { eventId: event.id, name: "Dr. Speaker (synthetic)", email: "speaker@example.test", phone: "+966500001234", status: "CONFIRMED" });
    const pm = await addMember(a.ctx, "project_manager", "PM");
    await withTenant({ orgId: a.orgId }, (tx) => tx.projectMember.create({ data: { organizationId: a.orgId, projectId: project.id, userId: pm.userId, role: "MEMBER" } }));
    const pmWs = await getEventWorkspace(pm.ctx, event.id);
    expect(pmWs.speakers[0].phone).toBe("•••1234");
    expect((await getEventWorkspace(a.ctx, event.id)).speakers[0].phone).toBe("+966500001234");

    // incidents: report → escalate → resolve requires resolution
    // staff outside the project can't report into it; project staff can
    await expect(reportIncident(staff.ctx, { projectId: project.id, eventId: event.id, title: "Mic failure hall A", severity: "HIGH" })).rejects.toThrow();
    await withTenant({ orgId: a.orgId }, (tx) => tx.projectMember.create({ data: { organizationId: a.orgId, projectId: project.id, userId: staff.userId, role: "MEMBER" } }));
    const inc = await reportIncident(staff.ctx, { projectId: project.id, eventId: event.id, title: "Mic failure hall A", severity: "HIGH" });
    await expect(updateIncident(staff.ctx, { id: inc.id, status: "RESOLVED", resolution: "x" })).rejects.toThrow("errors.forbidden");
    const esc = await updateIncident(a.ctx, { id: inc.id, escalate: true });
    expect(esc.severity).toBe("CRITICAL");
    expect(esc.escalationLevel).toBe(1);
    await expect(updateIncident(a.ctx, { id: inc.id, status: "RESOLVED" })).rejects.toThrow("errors.validation");
    await updateIncident(a.ctx, { id: inc.id, status: "RESOLVED", resolution: "Swapped to backup mic" });
    await expect(updateIncident(a.ctx, { id: inc.id, status: "OPEN" })).rejects.toThrow("errors.invalidTransition");
    const outbox = await adminDb().outboxEvent.count({ where: { organizationId: a.orgId, type: "incident.reported" } });
    expect(outbox).toBe(2);

    const cc = await commandCenter(a.ctx);
    const row = cc.events.find((e) => e.id === event.id)!;
    expect(row.readiness.ready).toBe(1);
    expect(row.currentCue?.title).toBe("Welcome speech");

    // other tenant cannot see the event
    const b = await createAgency("Other");
    await expect(getEventWorkspace(b.ctx, event.id)).rejects.toThrow();
    expect((await commandCenter(b.ctx)).events).toHaveLength(0);
  });
});

describe("VIP protocol", () => {
  it("guest registry, restricted notes with audited access, seating capacity/levels, arrival desk", async () => {
    const { a, project, event } = await setup();
    await withTenant({ orgId: a.orgId }, (tx) =>
      tx.recipient.createMany({ data: [
        { organizationId: a.orgId, projectId: project.id, code: "R-00001", nameAr: "سعادة الضيف التجريبي الأول", vipTier: "VVIP", mobile: "+966555000101", createdById: a.userId },
        { organizationId: a.orgId, projectId: project.id, code: "R-00002", nameAr: "الضيف التجريبي الثاني", vipTier: "VIP", mobile: "+966555000102", createdById: a.userId },
      ] }),
    );
    expect(await importGuestsFromRecipients(a.ctx, { projectId: project.id, eventId: event.id })).toEqual({ created: 2 });
    expect(await importGuestsFromRecipients(a.ctx, { projectId: project.id, eventId: event.id })).toEqual({ created: 0 }); // idempotent
    const g = await saveGuest(a.ctx, { projectId: project.id, eventId: event.id, nameAr: "ضيف المراسم (تجريبي)", category: "VVIP", protocolLevel: 1, restrictedNotes: "Security detail arrives 30 min early", mobile: "+966555000103" });

    const list = await listGuests(a.ctx, project.id);
    const item = list.guests.find((x) => x.id === g.id)!;
    expect(item.hasRestricted).toBe(true);
    expect(item).not.toHaveProperty("restrictedNotes");
    expect(list.guests.find((x) => x.nameAr.includes("الأول"))?.protocolLevel).toBe(1);

    // a coordinator without protocol.viewRestricted cannot read notes and cannot overwrite them
    const coord = await addMember(a.ctx, "team_lead", "Coordinator");
    await withTenant({ orgId: a.orgId }, (tx) => tx.projectMember.create({ data: { organizationId: a.orgId, projectId: project.id, userId: coord.userId, role: "LEAD", canViewVip: true } }));
    await expect(revealRestrictedNotes(coord.ctx, g.id)).rejects.toThrow("errors.forbidden");
    const notes = await revealRestrictedNotes(a.ctx, g.id);
    expect(notes.restrictedNotes).toContain("Security");
    const audits = await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "protocol.restricted_view", entityId: g.id } });
    expect(audits).toBe(1);

    // seating: protocol level gate and capacity (each write carries the version the desk loaded, BUSINESS_RULES §6)
    const ver = (id: string) => withTenant({ orgId: a.orgId }, (tx) => tx.guest.findUniqueOrThrow({ where: { id } })).then((x) => x.version);
    const front = await saveZone(a.ctx, { eventId: event.id, name: "Front row", capacity: 1, protocolLevel: 1 });
    const second = list.guests.find((x) => x.nameAr.includes("الثاني"))!;
    await expect(assignSeat(a.ctx, { guestId: second.id, seatZoneId: front.id, version: second.version })).rejects.toThrow("errors.validation");
    await assignSeat(a.ctx, { guestId: g.id, seatZoneId: front.id, seatLabel: "A1", version: g.version });
    const first = list.guests.find((x) => x.nameAr.includes("الأول"))!;
    await expect(assignSeat(a.ctx, { guestId: first.id, seatZoneId: front.id, seatLabel: "A2", version: first.version })).rejects.toThrow("errors.validation"); // full

    // arrival desk: valid transitions only, compare-and-set on the loaded version (two desks can't double-process)
    const loaded = await ver(g.id);
    await setAttendance(a.ctx, { guestId: g.id, attendance: "ARRIVED", version: loaded });
    await expect(setAttendance(a.ctx, { guestId: g.id, attendance: "ARRIVED", version: loaded })).rejects.toThrow("errors.staleWrite");
    await expect(setAttendance(a.ctx, { guestId: g.id, attendance: "CANCELLED", version: await ver(g.id) })).rejects.toThrow("errors.invalidTransition");
    await setAttendance(a.ctx, { guestId: g.id, attendance: "SEATED", version: await ver(g.id) });
    const board = await arrivalsBoard(a.ctx);
    expect(board.guests.find((x) => x.id === g.id)?.attendance).toBe("SEATED");

    const b = await createAgency("Other");
    await expect(listGuests(b.ctx, project.id)).rejects.toThrow();
    await expect(revealRestrictedNotes(b.ctx, g.id)).rejects.toThrow();
  });
});
