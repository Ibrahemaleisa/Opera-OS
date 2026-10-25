/**
 * Milestone 2, Stream N — escalation ladders (BUSINESS_RULES.md §3.4, NT-4/5/6, ES-1…7, KD-1).
 * Ticks run per organisation (`tickOrganization`) at simulated times; each tier fires once per
 * occurrence, consolidated per recipient, and quiet projects stay quiet.
 */
import { describe, expect, it } from "vitest";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { emit } from "@/server/modules/automation/outbox";
import { processOutbox } from "@/server/modules/automation/engine";
import { lastSchedulerTick, lastSchedulerTickAnywhere, schedulerFreshness, tickOrganization } from "@/server/modules/automation/scheduler";
import { requestApproval } from "@/server/modules/approvals/service";
import { saveDeliverable, upsertProjectMember } from "@/server/modules/projects/service";
import { updateTask } from "@/server/modules/tasks/service";
import { createWorkOrder, saveVendor, setWorkOrderStatus } from "@/server/modules/vendors/service";
import { reportIncident, updateIncident } from "@/server/modules/events/service";
import { generateDeliveries } from "@/server/modules/delivery/service";
import { addMember } from "../helpers";
import { savePreference } from "@/server/modules/notifications/service";
import { renderDigestEmail } from "@/server/modules/email/templates";
import { blankProject, clientUser, createClientCompany, recipients, task, templateId, type Agency } from "./qa-audit/qa-helpers";
import { createAgency } from "../helpers";

const MIN = 60_000;
const H = 3600_000;
const DAY = 24 * H;

async function tick(orgId: string, now: Date) {
  const org = await adminDb().organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
  return tickOrganization(org, now);
}

const notices = (orgId: string, where: Record<string, unknown> = {}) => adminDb().notification.findMany({ where: { organizationId: orgId, ...where }, orderBy: { createdAt: "asc" } });
/** Escalation-ladder notices only (assignment notices from the same tasks are not part of the ladder). */
const ladder = (orgId: string) => notices(orgId, { type: { notIn: ["task.assigned", "task.due_soon"] } });

const member = (projectId: string, userId: string, role: "MANAGER" | "MEMBER" | "CLIENT_APPROVER" = "MEMBER") => ({ projectId, userId, role, canApprove: role === "MANAGER", canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });

/** An agency with a director, a PM (the project's manager) and an employee task owner. */
async function team(name: string) {
  const a = await createAgency(name);
  const director = await addMember(a.ctx, "ops_director", "Director");
  const pm = await addMember(a.ctx, "project_manager", "PM");
  const emp = await addMember(a.ctx, "employee", "Reem");
  const p = await blankProject(pm.ctx, `${name} project`);
  await upsertProjectMember(pm.ctx, member(p.id, emp.userId));
  return { a, director, pm, emp, p };
}

describe("ES — escalation ladders", () => {
  it("NT-4 a task overdue 5 days, ticked every 5 minutes: owner one L1, PMs one L2, directors one L3", async () => {
    const { a, director, pm, emp, p } = await team("NT4");
    const now = Date.now();
    const t = await task(pm.ctx, p.id, "Receive guest list", { ownerId: emp.userId, dueAt: new Date(now - 5 * DAY) });
    for (let i = 0; i < 12; i++) await tick(a.orgId, new Date(now + i * 5 * MIN));
    const l1 = await notices(a.orgId, { type: "task.overdue", entityId: t.id });
    const esc = await notices(a.orgId, { type: "task.escalated" });
    expect(l1.map((n) => n.userId)).toEqual([emp.userId]);
    expect(l1[0].escalationLevel).toBe(1);
    expect(esc.filter((n) => n.userId === pm.userId).map((n) => n.escalationLevel)).toEqual([2]);
    expect(esc.filter((n) => n.userId === director.userId).map((n) => n.escalationLevel)).toEqual([3]);
    expect(esc.filter((n) => n.userId === a.userId), "owners are not pulled in while a director exists").toHaveLength(0);
    expect(esc).toHaveLength(2);
    const after = await adminDb().task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.escalationLevel).toBe(3);
    expect(after.escalatedAt).not.toBeNull();
    // the PM's L2 names the task, its lateness and owner (UX note 4)
    const l2 = esc.find((n) => n.userId === pm.userId)!;
    expect(JSON.parse(l2.body!)).toMatchObject({ title: "Receive guest list", days: 5, owner: "Reem" });
    // L2/L3 e-mail is mandatory; the owner's L1 e-mail is optional (default on)
    expect(await adminDb().notificationDelivery.count({ where: { organizationId: a.orgId, notificationId: { in: [...l1, ...esc].map((n) => n.id) } } })).toBe(3);
    // one marker per tier, recorded in the audit trail
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "task.escalation", entityId: t.id } })).toBe(3);
  });

  it("escalation markers never bump Task.version (they are not user-editable content)", async () => {
    const { a, pm, emp, p } = await team("NoVersion");
    const t = await task(pm.ctx, p.id, "Late", { ownerId: emp.userId, dueAt: new Date(Date.now() - 4 * DAY) });
    const before = await adminDb().task.findUniqueOrThrow({ where: { id: t.id } });
    await tick(a.orgId, new Date());
    const after = await adminDb().task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.escalationLevel).toBe(3);
    expect(after.version).toBe(before.version);
  });

  it("ES-7 no daily repeats: ticks on 3 more days with nothing changed create no new notices after L3", async () => {
    const { a, pm, emp, p } = await team("ES7");
    const now = Date.now();
    const t = await task(pm.ctx, p.id, "Book hotel block", { ownerId: emp.userId, dueAt: new Date(now - 4 * DAY) });
    await tick(a.orgId, new Date(now));
    const first = (await ladder(a.orgId)).filter((n) => n.entityId === t.id || n.type === "task.escalated").length;
    expect(first).toBe(3);
    for (let d = 1; d <= 3; d++) for (const h of [0, 6, 12]) await tick(a.orgId, new Date(now + d * DAY + h * H));
    expect((await ladder(a.orgId)).filter((n) => n.entityId === t.id || n.type === "task.escalated").length).toBe(first);
    expect(await adminDb().outboxEvent.count({ where: { organizationId: a.orgId, type: "task.overdue" } }), "one overdue event per occurrence").toBe(1);
  });

  it("NT-5 moving the due date forward (re-plan) starts a new occurrence: a new L1 once it passes again", async () => {
    const { a, pm, emp, p } = await team("NT5");
    const now = Date.now();
    const t = await task(pm.ctx, p.id, "Print badges", { ownerId: emp.userId, dueAt: new Date(now - H) });
    await tick(a.orgId, new Date(now));
    expect(await notices(a.orgId, { type: "task.overdue", entityId: t.id })).toHaveLength(1);
    const cur = await adminDb().task.findUniqueOrThrow({ where: { id: t.id } });
    expect(cur.escalationLevel).toBe(1);
    await updateTask(pm.ctx, { id: t.id, version: cur.version, dueAt: new Date(now + 2 * DAY) } as never);
    await tick(a.orgId, new Date(now + 5 * MIN));
    expect((await adminDb().task.findUniqueOrThrow({ where: { id: t.id } })).escalationLevel, "re-planned: back to L0").toBe(0);
    await tick(a.orgId, new Date(now + 2 * DAY + H));
    const l1 = await notices(a.orgId, { type: "task.overdue", entityId: t.id });
    expect(l1).toHaveLength(2);
    expect(new Set(l1.map((n) => n.dedupeKey)).size).toBe(2);
  });

  it("NT-6 seven tasks reaching L2 for the same PM in one tick become one consolidated notice", async () => {
    const { a, pm, p } = await team("NT6");
    const now = Date.now();
    const ids: string[] = [];
    // unowned tasks skip L1 and go to the PMs at once
    for (let i = 0; i < 7; i++) ids.push((await task(pm.ctx, p.id, `Item ${i + 1}`, { dueAt: new Date(now - 2 * H) })).id);
    await tick(a.orgId, new Date(now));
    const esc = await notices(a.orgId, { type: "task.escalated", userId: pm.userId });
    expect(esc).toHaveLength(1);
    expect(esc[0].title).toBe("notif.taskEscalatedMany");
    expect(JSON.parse(esc[0].body!)).toEqual({ count: 7 });
    expect(esc[0].escalationLevel).toBe(2);
    // each item still records its own level
    const tasks = await adminDb().task.findMany({ where: { id: { in: ids } } });
    expect(tasks.every((t) => t.escalationLevel === 2)).toBe(true);
    await tick(a.orgId, new Date(now + 5 * MIN));
    expect(await notices(a.orgId, { type: "task.escalated", userId: pm.userId })).toHaveLength(1);
  });

  it("an owner who left is skipped: the ladder goes to the PMs (fallback directors → owners when the PM left too)", async () => {
    const { a, director, pm, emp, p } = await team("Leaver");
    const t = await task(pm.ctx, p.id, "Venue contract", { ownerId: emp.userId, dueAt: new Date(Date.now() - 2 * H) });
    await adminDb().membership.updateMany({ where: { organizationId: a.orgId, userId: { in: [emp.userId, pm.userId] } }, data: { status: "SUSPENDED" } });
    await tick(a.orgId, new Date());
    const all = await ladder(a.orgId);
    expect(all.some((n) => n.userId === emp.userId || n.userId === pm.userId)).toBe(false);
    const esc = all.filter((n) => n.type === "task.escalated" && n.entityId === t.id);
    expect(esc.map((n) => n.userId)).toEqual([director.userId]);
  });

  it("ON_HOLD (quiet) projects get no escalations; COMPLETED keeps only the closeout tail", async () => {
    const { a, pm, emp, p } = await team("Quiet");
    const t = await task(pm.ctx, p.id, "Paused work", { ownerId: emp.userId, dueAt: new Date(Date.now() - 3 * DAY) });
    await adminDb().project.update({ where: { id: p.id }, data: { status: "ON_HOLD" } });
    await tick(a.orgId, new Date());
    expect(await ladder(a.orgId)).toHaveLength(0);
    await adminDb().project.update({ where: { id: p.id }, data: { status: "COMPLETED" } });
    const closeout = await task(pm.ctx, p.id, "Closeout", { ownerId: emp.userId, dueAt: new Date(Date.now() - H), tags: ["closeout"] }).catch(async () =>
      adminDb().task.create({ data: { organizationId: a.orgId, projectId: p.id, number: 999, title: "Closeout", ownerId: emp.userId, dueAt: new Date(Date.now() - H), tags: ["closeout"], createdById: pm.userId } }),
    );
    await tick(a.orgId, new Date(Date.now() + MIN));
    const n = await ladder(a.orgId);
    expect(n.map((x) => x.entityId)).toEqual([closeout.id]);
    expect(n.some((x) => x.entityId === t.id)).toBe(false);
  });

  it("two overlapping ticks fire each tier once; the heartbeat records the tick (System health §7.4)", async () => {
    const { a, pm, emp, p } = await team("Overlap");
    expect(await lastSchedulerTick(a.orgId)).toBeNull();
    await task(pm.ctx, p.id, "Late", { ownerId: emp.userId, dueAt: new Date(Date.now() - 4 * DAY) });
    const now = new Date();
    await Promise.all([tick(a.orgId, now), tick(a.orgId, now), tick(a.orgId, now)]);
    await tick(a.orgId, now);
    expect(await ladder(a.orgId)).toHaveLength(3);
    const last = await lastSchedulerTick(a.orgId);
    expect(last).not.toBeNull();
    expect(Date.now() - last!.getTime()).toBeLessThan(60_000);
  });

  it("rare ticks (e.g. a daily cron) still fire every tier once — late, never lost — and System health flags the gap (SW-9)", async () => {
    const { a, director, pm, emp, p } = await team("RareTicks");
    const now = Date.now();
    const t = await task(pm.ctx, p.id, "Hotel rooming list", { ownerId: emp.userId, dueAt: new Date(now + H) });
    const ap = await requestApproval(emp.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Rooming list", approverType: "INTERNAL", approverUserId: null } as never);
    // once a day for a week
    for (let d = 0; d <= 7; d++) await tick(a.orgId, new Date(now + d * DAY + 2 * H));
    const n = await ladder(a.orgId);
    const of = (type: string, userId: string, entityId?: string) => n.filter((x) => x.type === type && x.userId === userId && (!entityId || x.entityId === entityId)).length;
    expect([of("task.overdue", emp.userId, t.id), of("task.escalated", pm.userId), of("task.escalated", director.userId)]).toEqual([1, 1, 1]);
    // the approval: overdue (L1), escalated to the PM (L2) and directors (L3), each once; the pre-due reminder fired on day 1
    expect(of("approval.reminder", pm.userId, ap.id)).toBe(1);
    expect(of("approval.overdue", pm.userId, ap.id)).toBe(1);
    expect(of("approval.escalated", pm.userId, ap.id) + of("approval.escalated", director.userId, ap.id)).toBe(2);
    const last = await lastSchedulerTick(a.orgId);
    expect(schedulerFreshness(last, new Date(last!.getTime() + 10 * MIN)).state).toBe("ok");
    expect(schedulerFreshness(last, new Date(last!.getTime() + 20 * MIN)).state).toBe("warning");
    expect(schedulerFreshness(last, new Date(last!.getTime() + 61 * MIN)).state).toBe("critical");
    expect(schedulerFreshness(null).state).toBe("unknown");
    expect(await lastSchedulerTickAnywhere()).not.toBeNull();
  });

  it("ES-1 / KD-1 a work order due yesterday and still IN_PROGRESS raises workorder.overdue (payload has the id) and the vendor's users get L1", async () => {
    const { a, pm, director, p } = await team("ES1");
    const v = await saveVendor(a.ctx, { name: "AV Rentals", category: "AV", status: "ACTIVE" } as never);
    const vendorUser = await addMember(a.ctx, "vendor", "Vendor rep");
    await adminDb().membership.updateMany({ where: { organizationId: a.orgId, userId: vendorUser.userId }, data: { vendorId: v.id } });
    const now = Date.now();
    const wo = await createWorkOrder(pm.ctx, { projectId: p.id, vendorId: v.id, title: "LED wall installation", dueAt: new Date(now - DAY) });
    await setWorkOrderStatus(pm.ctx, { id: wo.id, status: "ACCEPTED" }).catch(() => undefined);
    await setWorkOrderStatus(pm.ctx, { id: wo.id, status: "IN_PROGRESS" }).catch(() => undefined);
    await tick(a.orgId, new Date(now));
    const ev = await adminDb().outboxEvent.findMany({ where: { organizationId: a.orgId, type: "workorder.overdue" } });
    expect(ev).toHaveLength(1);
    expect((ev[0].payload as { workOrderId: string }).workOrderId).toBe(wo.id);
    const l1 = await notices(a.orgId, { type: "workorder.overdue", entityId: wo.id });
    expect(l1.map((n) => n.userId).sort()).toEqual([vendorUser.userId, pm.userId].sort()); // vendor users + WO creator
    // L2 → PMs at due + 24 h, L3 → directors at due + 72 h, each once
    await tick(a.orgId, new Date(now + 5 * MIN));
    await tick(a.orgId, new Date(now + 3 * DAY));
    await tick(a.orgId, new Date(now + 3 * DAY + 5 * MIN));
    const esc = await notices(a.orgId, { type: "workorder.escalated", entityId: wo.id });
    expect(esc.map((n) => [n.userId, n.escalationLevel])).toEqual([[pm.userId, 2], [director.userId, 3]]);
    // delivered: the ladder stops
    expect(await adminDb().outboxEvent.count({ where: { organizationId: a.orgId, type: { in: ["workorder.overdue", "workorder.escalated"] } } })).toBe(3);
  });

  it("a work order not accepted 48 h after issue reminds the vendor and the creator once", async () => {
    const { a, pm, p } = await team("WONotAccepted");
    const v = await saveVendor(a.ctx, { name: "Stage Co", category: "AV", status: "ACTIVE" } as never);
    const wo = await createWorkOrder(pm.ctx, { projectId: p.id, vendorId: v.id, title: "Stage build", dueAt: new Date(Date.now() + 10 * DAY) });
    await tick(a.orgId, new Date(Date.now() + 47 * H));
    expect(await notices(a.orgId, { type: "workorder.not_accepted" })).toHaveLength(0);
    await tick(a.orgId, new Date(Date.now() + 49 * H));
    await tick(a.orgId, new Date(Date.now() + 50 * H));
    const n = await notices(a.orgId, { type: "workorder.not_accepted", entityId: wo.id });
    expect(n.map((x) => x.userId)).toEqual([pm.userId]);
  });

  it("ES-2 a CRITICAL incident still OPEN after 15 minutes reaches directors and owners (L2, escalationLevel 1); acknowledged at minute 10 it does not", async () => {
    const { a, director, pm, p } = await team("ES2");
    const i = await reportIncident(pm.ctx, { projectId: p.id, title: "Generator failure", severity: "CRITICAL" } as never);
    const t0 = i.createdAt.getTime();
    await tick(a.orgId, new Date(t0 + 10 * MIN));
    expect(await notices(a.orgId, { type: "incident.escalated" })).toHaveLength(0);
    await tick(a.orgId, new Date(t0 + 16 * MIN));
    await tick(a.orgId, new Date(t0 + 21 * MIN));
    const l2 = await notices(a.orgId, { type: "incident.escalated", entityId: i.id });
    expect(l2.map((n) => n.userId).sort()).toEqual([a.userId, director.userId].sort());
    expect(l2.every((n) => n.escalationLevel === 2 && n.priority === "CRITICAL")).toBe(true);
    expect((await adminDb().incident.findUniqueOrThrow({ where: { id: i.id } })).escalationLevel).toBe(1);
    // 60 minutes: all owners again, "unacknowledged 1 h"
    await tick(a.orgId, new Date(t0 + 61 * MIN));
    const l3 = await notices(a.orgId, { type: "incident.escalated", entityId: i.id, escalationLevel: 3 });
    expect(l3.map((n) => [n.userId, n.title])).toEqual([[a.userId, "notif.incidentUnacknowledgedHour"]]);

    const j = await reportIncident(pm.ctx, { projectId: p.id, title: "Door jammed", severity: "CRITICAL" } as never);
    await updateIncident(director.ctx, { id: j.id, status: "ACKNOWLEDGED" } as never);
    await tick(a.orgId, new Date(j.createdAt.getTime() + 16 * MIN));
    expect(await notices(a.orgId, { type: "incident.escalated", entityId: j.id })).toHaveLength(0);
    expect((await adminDb().incident.findUniqueOrThrow({ where: { id: j.id } })).escalationLevel).toBe(0);
  });

  it("MEDIUM incidents: PMs in-app at report, then by e-mail after 4 h unacknowledged", async () => {
    const { a, pm, p } = await team("IncMedium");
    const i = await reportIncident(a.ctx, { projectId: p.id, title: "Signage missing", severity: "MEDIUM" } as never);
    await tick(a.orgId, new Date(i.createdAt.getTime() + MIN));
    const r = await notices(a.orgId, { type: "incident.reported", entityId: i.id });
    expect(r.map((n) => n.userId)).toEqual([pm.userId]);
    expect(await adminDb().notificationDelivery.count({ where: { notificationId: r[0].id } }), "MEDIUM report is in-app only").toBe(0);
    await tick(a.orgId, new Date(i.createdAt.getTime() + 4 * H + MIN));
    const esc = await notices(a.orgId, { type: "incident.escalated", entityId: i.id });
    expect(esc.map((n) => n.userId)).toEqual([pm.userId]);
    expect(await adminDb().notificationDelivery.count({ where: { notificationId: esc[0].id } })).toBe(1);
  });

  it("ES-3 an approval requested at T with the default SLA: reminder T+24 h, L1 T+48 h, L2 T+72 h, L3 T+96 h, each once", async () => {
    const { a, director, pm, emp, p } = await team("ES3");
    const t = await task(pm.ctx, p.id, "Approve floor plan", { ownerId: emp.userId });
    const ap = await requestApproval(emp.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Floor plan", approverType: "INTERNAL", approverUserId: null } as never);
    await processOutbox(a.orgId);
    const T = ap.createdAt.getTime();
    const types = async () => (await notices(a.orgId, { entityId: ap.id })).map((n) => `${n.type}@${n.userId === pm.userId ? "pm" : n.userId === emp.userId ? "req" : n.userId === director.userId ? "dir" : "owner"}`);
    await tick(a.orgId, new Date(T + 23 * H));
    expect(await types()).toEqual([]);
    for (const h of [24, 24.1, 30]) await tick(a.orgId, new Date(T + h * H + MIN));
    expect(await types()).toEqual(["approval.reminder@pm"]);
    for (const h of [48, 50]) await tick(a.orgId, new Date(T + h * H + MIN));
    expect((await types()).sort()).toEqual(["approval.overdue@pm", "approval.overdue@req", "approval.reminder@pm"]);
    for (const h of [72, 80]) await tick(a.orgId, new Date(T + h * H + MIN));
    expect((await types()).filter((x) => x.startsWith("approval.escalated"))).toEqual(["approval.escalated@pm"]);
    for (const h of [96, 120]) await tick(a.orgId, new Date(T + h * H + MIN));
    expect((await types()).filter((x) => x.startsWith("approval.escalated")).sort()).toEqual(["approval.escalated@dir", "approval.escalated@pm"]);
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "approval.escalation", entityId: ap.id } })).toBe(4);
  });

  it("ES-4 a client approval at L2: the PMs and the requester are told to chase, and the client approvers get exactly one more reminder", async () => {
    const a = await createAgency("ES4");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const co = await createClientCompany(a, "Ministry");
    const c1 = await clientUser(a, co.id, "Client approver");
    const p = await blankProject(a.ctx, "Client project", { clientId: co.id });
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER"));
    await upsertProjectMember(a.ctx, member(p.id, c1.userId, "CLIENT_APPROVER"));
    const d = await saveDeliverable(pm.ctx, { projectId: p.id, title: "Run of show v3", status: "IN_PROGRESS", clientVisible: true, requiresApproval: true } as never);
    const ap = await requestApproval(pm.ctx, { projectId: p.id, entityType: "DELIVERABLE", entityId: d.id, title: "Approve run of show", approverType: "CLIENT", approverUserId: null } as never);
    const T = ap.createdAt.getTime();
    await tick(a.orgId, new Date(T + 48 * H + MIN)); // L1: client approvers + requester
    const before = (await notices(a.orgId, { entityId: ap.id, userId: c1.userId })).length;
    await tick(a.orgId, new Date(T + 72 * H + MIN));
    await tick(a.orgId, new Date(T + 73 * H));
    const chase = await notices(a.orgId, { entityId: ap.id, type: "approval.escalated" });
    // the project's PMs (the creating owner and the PM) — the requester is the PM here
    expect(chase.map((n) => n.userId).sort()).toEqual([a.userId, pm.userId].sort());
    expect(chase.every((n) => n.title === "notif.approvalClientChase")).toBe(true);
    const clientNotices = await notices(a.orgId, { entityId: ap.id, userId: c1.userId });
    expect(clientNotices.length - before).toBe(1);
    expect(clientNotices.at(-1)!.type).toBe("approval.reminder");
  });

  it("ES-5 a campaign 40 h from its deadline with 12 deliveries not out: the PMs get one consolidated T1 naming 12", async () => {
    const a = await createAgency("ES5");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const p = await blankProject(a.ctx, "Delivery", { templateIds: [await templateId(a as Agency, "vip-physical-delivery")], eventStartAt: new Date(Date.now() + 20 * DAY) });
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER"));
    const campaign = await adminDb().invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "PHYSICAL" } });
    const rs = await recipients(a as Agency, p.id, 12);
    await generateDeliveries(a.ctx, { campaignId: campaign.id, recipientIds: rs.map((r) => r.id) });
    const now = Date.now();
    await adminDb().invitationCampaign.update({ where: { id: campaign.id }, data: { deliveryDeadline: new Date(now + 40 * H) } });
    await tick(a.orgId, new Date(now));
    await tick(a.orgId, new Date(now + 5 * MIN));
    const t1 = await notices(a.orgId, { type: "delivery.deadline_risk" });
    const forPm = t1.filter((n) => n.userId === pm.userId);
    expect(forPm).toHaveLength(1);
    expect(forPm[0].title).toBe("notif.deliveryDeadlineT1");
    expect(JSON.parse(forPm[0].body!)).toMatchObject({ count: 12 });
    // 24 h before: PMs + directors (fallback owners) once more; passed: directors
    await tick(a.orgId, new Date(now + 17 * H));
    await tick(a.orgId, new Date(now + 41 * H));
    const all = await notices(a.orgId, { type: "delivery.deadline_risk" });
    expect(all.map((n) => n.title).filter((x) => x.endsWith("T2")).length).toBeGreaterThan(0);
    expect(all.filter((n) => n.title.endsWith("T3")).map((n) => n.userId)).toEqual([a.userId]);
  });

  it("ES-6 three failed attempts on one delivery leave exactly one open follow-up task", async () => {
    const a = await createAgency("ES6");
    const p = await blankProject(a.ctx, "Follow-ups");
    const payload = { deliveryId: "dlv_1", projectId: p.id, campaignId: "c1", code: "TRK-1", reason: "nobody home", link: `/projects/${p.id}/delivery`, entityType: "DELIVERY", entityId: "dlv_1" };
    for (let i = 0; i < 3; i++) {
      await withTenant({ orgId: a.orgId }, (tx) => emit(tx, a.ctx, "delivery.failed", { ...payload, reason: `attempt ${i + 1}` }));
      await Promise.all([processOutbox(a.orgId), processOutbox(a.orgId)]);
    }
    const open = await adminDb().task.findMany({ where: { organizationId: a.orgId, tags: { has: "delivery:dlv_1" } } });
    expect(open).toHaveLength(1);
    expect(open[0].description).toContain("attempt 2");
    expect(open[0].description).toContain("attempt 3");
  });
});


describe("NT — daily digest (§3.2 NT rule 2)", () => {
  it("one e-mail per user per day at 07:30 Riyadh, only when something needs them, never repeated; the preference switches it off", async () => {
    const { a, pm, emp, p } = await team("Digest");
    const lead = await addMember(a.ctx, "team_lead", "Lead");
    // a Riyadh day in the future: 07:00 (before) and 07:31 (after) local = 04:00 / 04:31 UTC
    const day = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    const at = (hhmmUtc: string) => new Date(`${day}T${hhmmUtc}:00Z`);
    await task(pm.ctx, p.id, "Overdue for Reem", { ownerId: emp.userId, dueAt: new Date(at("04:00").getTime() - 2 * DAY) });
    await task(pm.ctx, p.id, "Due today for Reem", { ownerId: emp.userId, dueAt: at("15:00") });
    const digests = () => adminDb().notificationDelivery.findMany({ where: { organizationId: a.orgId, template: "digest" } });
    await tick(a.orgId, at("04:00"));
    expect(await digests(), "not before 07:30 Riyadh").toHaveLength(0);
    await tick(a.orgId, at("04:31"));
    await tick(a.orgId, at("04:36"));
    await tick(a.orgId, at("12:00"));
    const d = await digests();
    // only Reem owns past-due / due-today work (escalation notices to the PM are not digest items)
    expect(d.map((x) => x.userId)).toEqual([emp.userId]);
    expect(d[0].dedupeKey).toBe(`digest:${emp.userId}:${day}`);
    expect((d[0].params as { digest: unknown }).digest).toMatchObject({ overdueCount: 1, dueTodayCount: 1 });
    expect(d.some((x) => x.userId === lead.userId), "nothing needs them: no digest").toBe(false);
    expect(d[0].status).toBe("SIMULATED");
    // next day, switched off: nothing
    await savePreference(emp.ctx, { type: "digest.daily", inApp: true, email: false, digest: "none" });
    await tick(a.orgId, new Date(at("04:31").getTime() + DAY));
    expect(await digests()).toHaveLength(1);
  });

  it("the digest reads as a short 'here's what needs you' note in the recipient's language", () => {
    const digest = { overdue: [{ title: "Receive guest list", code: "PRJ-1-21" }], overdueCount: 3, dueToday: [], dueTodayCount: 0, approvals: [{ title: "Floor plan", code: "PRJ-1" }], approvalsCount: 1, mentions: 2 };
    const p = { type: "digest.daily", titleKey: "notif.digestMail.heading", params: {}, link: "/my-work", surface: "o" as const, priority: "NORMAL" as const, escalationLevel: 0, digest, day: "2026-10-26" };
    const en = renderDigestEmail("en", p, { orgSlug: "acme", orgName: "Acme" });
    expect(en.subject).toBe("Opera — Your morning summary: 6 things need you");
    expect(en.text).toContain("Good morning — here's what needs you today");
    expect(en.text).toContain("Waiting for your decision (1)");
    expect(en.text).toContain("• Receive guest list (PRJ-1-21)");
    expect(en.text).toContain("And 2 more in My work.");
    expect(en.text).not.toContain("Due today"); // empty sections are left out
    expect(en.text).toContain("/o/acme/my-work");
    const ar = renderDigestEmail("ar", p, { orgSlug: "acme", orgName: "Acme" });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.subject).toContain("ملخص صباحك");
  });
});
