/**
 * QA gate for Milestone 1 (Agent 5) — attempts to BYPASS the Stream 1 fixes for F-02, F-03, F-04,
 * F-06, F-13 and F-16. Each `it` states the expected secure behaviour. "(control)" tests confirm a
 * fix holds; the others are the bypass attempts and fail while the bypass works.
 */
import { describe, expect, it } from "vitest";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { kickOutbox } from "@/server/jobs/dispatch";
import { decideApproval, requestApproval, withdrawApproval } from "@/server/modules/approvals/service";
import { processOutbox } from "@/server/modules/automation/engine";
import { schedulerTick } from "@/server/modules/automation/scheduler";
import { bulkAssign, generateDeliveries, updateDeliveryStatus } from "@/server/modules/delivery/service";
import { addAudience, getRsvpPage, launchCampaign, optOut, removeAudience, requestCampaignApproval, saveDigitalCampaign, submitRsvp } from "@/server/modules/digital/service";
import { dispatchDueCampaigns } from "@/server/modules/digital/sender";
import { signedUrlFor, storeAttachment } from "@/server/modules/files/service";
import { createPurchaseOrder, submitPurchaseOrder } from "@/server/modules/finance/service";
import { changeMemberRole, setMemberStatus } from "@/server/modules/org/service";
import { getProjectOverview, listProjectActivity, saveDeliverable, saveMilestone, setProjectStatus, upsertProjectMember } from "@/server/modules/projects/service";
import { saveGuest } from "@/server/modules/protocol/service";
import { globalSearch } from "@/server/modules/search/service";
import { changeTaskStatus, getTaskDetail, listProjectTasks } from "@/server/modules/tasks/service";
import { DEFAULT_STATUSES } from "@/server/modules/templates/definition";
import { saveVendor } from "@/server/modules/vendors/service";
import { sha256Hex } from "@/server/auth/crypto";
import { addMember, createAgency } from "../../helpers";
import { blankProject, clientUser, createClientCompany, membershipId, recipients, task, templateId, type Agency } from "./qa-helpers";

const DAY = 86_400_000;
const BODY = "{{honorific}} {{name}}، يسرنا دعوتكم. للتأكيد: {{rsvp_link}}";
type Role = "MANAGER" | "LEAD" | "MEMBER" | "FREELANCER" | "CLIENT_APPROVER";
const member = (projectId: string, userId: string, role: Role, extra: Partial<{ workstreamIds: string[]; canViewVip: boolean; canApprove: boolean; canViewFinance: boolean }> = {}) => ({
  projectId, userId, role, canApprove: extra.canApprove ?? false, canExport: false, canViewFinance: extra.canViewFinance ?? false, canViewVip: extra.canViewVip ?? false, workstreamIds: extra.workstreamIds ?? [],
});

async function campaignSetup(a: Agency, name: string, opts: { scheduledAt?: Date | null } = {}) {
  const p = await blankProject(a.ctx, name, { templateIds: [await templateId(a, "vip-digital-campaign")], eventStartAt: new Date(Date.now() + 30 * DAY) });
  const rs = await recipients(a, p.id, 3);
  const draft = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "DIGITAL" } }));
  const save = (ctx = a.ctx, extra: Partial<Parameters<typeof saveDigitalCampaign>[1]> = {}) =>
    saveDigitalCampaign(ctx, { id: draft.id, projectId: p.id, name: "VIP gala invitation", channel: "SMS", bodyTemplate: BODY, rsvpEnabled: true, qrEnabled: true, scheduledAt: opts.scheduledAt ?? null, ...extra });
  const c = await save();
  const sent = () => adminDb().messageJob.count({ where: { invitation: { campaignId: c.id } } });
  const status = async () => (await adminDb().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).status;
  return { p, rs, c, save, sent, status };
}

async function approvedCampaign(name: string, opts: { scheduledAt?: Date | null } = {}) {
  const a = await createAgency(name);
  const director = await addMember(a.ctx, "ops_director", "Approving director");
  const s = await campaignSetup(a, name, opts);
  await addAudience(a.ctx, { campaignId: s.c.id, recipientIds: s.rs.map((r) => r.id) });
  const appr = await requestCampaignApproval(a.ctx, s.c.id);
  await decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
  return { a, director, ...s };
}

describe("QA M1 · F-02 approval bypass attempts", () => {
  it("a project manager cannot decide a deliverable approval they requested (control)", async () => {
    const a = await createAgency("QA M1 DelivSelf");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER", { canApprove: true }));
    const d = await saveDeliverable(pm.ctx, { projectId: p.id, title: "Stage render", status: "IN_PROGRESS", clientVisible: false, requiresApproval: true });
    const appr = await requestApproval(pm.ctx, { projectId: p.id, entityType: "DELIVERABLE", entityId: d.id, title: "Render", approverType: "INTERNAL" });
    await expect(decideApproval(pm.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toThrow();
  });

  it("naming oneself as the approver of a milestone is refused at request time (control)", async () => {
    const a = await createAgency("QA M1 MilestoneSelf");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER", { canApprove: true }));
    const ms = await saveMilestone(pm.ctx, { projectId: p.id, title: "Venue locked", status: "IN_PROGRESS", clientVisible: true });
    await expect(requestApproval(pm.ctx, { projectId: p.id, entityType: "MILESTONE", entityId: ms.id, title: "Venue", approverType: "INTERNAL", approverUserId: pm.userId })).rejects.toThrow();
  });

  it("withdraw-then-request does not let the requester become the decider (control)", async () => {
    const a = await createAgency("QA M1 Withdraw");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER", { canApprove: true }));
    const t = await task(pm.ctx, p.id, "Badge artwork", { requiresApproval: true, ownerId: pm.userId });
    await changeTaskStatus(pm.ctx, { id: t.id, status: "review" });
    const first = await requestApproval(pm.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Badges", approverType: "INTERNAL", approverUserId: a.userId });
    await withdrawApproval(pm.ctx, { approvalId: first.id, reason: "re-routing to myself" });
    await expect(requestApproval(pm.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Badges", approverType: "INTERNAL", approverUserId: pm.userId })).rejects.toThrow();
    const second = await requestApproval(pm.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Badges", approverType: "INTERNAL" });
    await expect(decideApproval(pm.ctx, { approvalId: second.id, decision: "APPROVED", comment: null })).rejects.toThrow();
    expect((await getTaskDetail(a.ctx, t.id)).task.statusCategory).not.toBe("DONE");
  });

  it("the generic request action refuses finance and campaign entities (control)", async () => {
    const a = await createAgency("QA M1 Generic");
    await addMember(a.ctx, "ops_director", "Director");
    const p = await blankProject(a.ctx);
    const v = await saveVendor(a.ctx, { name: "Printers", category: "PRINTING", status: "ACTIVE" });
    const po = await createPurchaseOrder(a.ctx, { projectId: p.id, vendorId: v.id, title: "Print", budgetCategory: "PRINTING", amount: 1000, vatAmount: 150 });
    await expect(requestApproval(a.ctx, { projectId: p.id, entityType: "PURCHASE_ORDER", entityId: po.id, title: "PO", approverType: "INTERNAL" })).rejects.toThrow();
  });

  it("a decision on a deliverable that changed after the request is refused as stale (control)", async () => {
    const a = await createAgency("QA M1 Stale");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER", { canApprove: true }));
    const d = await saveDeliverable(a.ctx, { projectId: p.id, title: "Seating plan", status: "IN_PROGRESS", clientVisible: false, requiresApproval: true });
    const appr = await requestApproval(a.ctx, { projectId: p.id, entityType: "DELIVERABLE", entityId: d.id, title: "Seating", approverType: "INTERNAL" });
    const edited = await saveDeliverable(a.ctx, { id: d.id, projectId: p.id, title: "Seating plan v2", status: "IN_PROGRESS", clientVisible: false, requiresApproval: true }).then(() => true, () => false);
    if (edited) await expect(decideApproval(pm.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toThrow();
    const now = await withTenant({ orgId: a.orgId }, (tx) => tx.deliverable.findUniqueOrThrow({ where: { id: d.id } }));
    expect(now.status).not.toBe("APPROVED");
  });

  // Open (S3, F-02 residual): separation of duties for project work keys on the requester only, not on the task owner.
  // Depends on owner decision #4 (PRODUCT_AUDIT §7). Proposed for Milestone 2.
  it.fails("[F-02 residual · owner decision #4] known defect, Milestone 2 — the person who did the work cannot approve it when a colleague pressed 'request approval'", async () => {
    const a = await createAgency("QA M1 OwnWork");
    const pm = await addMember(a.ctx, "project_manager", "PM who did the work");
    const emp = await addMember(a.ctx, "employee", "Coordinator");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER", { canApprove: true }));
    await upsertProjectMember(a.ctx, member(p.id, emp.userId, "MEMBER"));
    const t = await task(a.ctx, p.id, "VIP seating chart", { requiresApproval: true, ownerId: pm.userId });
    await changeTaskStatus(pm.ctx, { id: t.id, status: "review" });
    const appr = await requestApproval(emp.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Seating chart", approverType: "INTERNAL" });
    // EXPECTED (four-eyes on work, mirroring the finance rule on spend): the task owner is not a decider
    await expect(decideApproval(pm.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toThrow();
  });

  // Open (S3, F-02 residual): campaign four-eyes excludes the requester but not the author of the content.
  // Depends on owner decision #4. Proposed for Milestone 2.
  it.fails("[F-02 residual · owner decision #4] known defect, Milestone 2 — the author of a campaign cannot approve it when a colleague requested the approval", async () => {
    const a = await createAgency("QA M1 CampaignAuthor");
    const director = await addMember(a.ctx, "ops_director", "Director who wrote it");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const s = await campaignSetup(a, "QA M1 CampaignAuthor");
    await upsertProjectMember(a.ctx, member(s.p.id, pm.userId, "MANAGER"));
    await s.save(director.ctx, { bodyTemplate: `${BODY} — written by the director` }); // the director authors the content
    await addAudience(director.ctx, { campaignId: s.c.id, recipientIds: s.rs.map((r) => r.id) });
    const appr = await requestCampaignApproval(pm.ctx, s.c.id);
    await expect(decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toThrow();
  });
});

describe("QA M1 · F-03 / F-04 campaign bypass attempts", () => {
  it("editing the message after approval returns the campaign to draft and blocks launch (control)", async () => {
    const { a, c, save, sent, status } = await approvedCampaign("QA M1 EditAfter");
    const r = await save(a.ctx, { bodyTemplate: `${BODY} (edited)` });
    expect((r as { approvalInvalidated?: boolean }).approvalInvalidated).toBe(true);
    expect(await status()).toBe("DRAFT");
    await expect(launchCampaign(a.ctx, c.id)).rejects.toThrow();
    expect(await sent()).toBe(0);
  });

  it("removing recipients after approval also voids the approval (control)", async () => {
    const { a, c, status } = await approvedCampaign("QA M1 RemoveAfter");
    const inv = await adminDb().digitalInvitation.findFirstOrThrow({ where: { campaignId: c.id } });
    await removeAudience(a.ctx, { campaignId: c.id, invitationIds: [inv.id] });
    expect(await status()).toBe("DRAFT");
  });

  it("a campaign scheduled for next week is not released by early scheduler ticks or inline kicks (control)", async () => {
    const { a, c, sent, status } = await approvedCampaign("QA M1 Early", { scheduledAt: new Date(Date.now() + 7 * DAY) });
    expect((await launchCampaign(a.ctx, c.id)).status).toBe("SCHEDULED");
    await schedulerTick();
    await kickOutbox(a.orgId);
    await dispatchDueCampaigns(a.orgId);
    expect(await sent()).toBe(0);
    expect(await status()).toBe("SCHEDULED");
  });

  it("once due, a scheduled campaign is released by the next inline kick (control)", async () => {
    const { a, c, sent } = await approvedCampaign("QA M1 Due", { scheduledAt: new Date(Date.now() + 7 * DAY) });
    await launchCampaign(a.ctx, c.id);
    await adminDb().invitationCampaign.update({ where: { id: c.id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    await kickOutbox(a.orgId);
    expect(await sent()).toBe(3);
  });

  it("a scheduled campaign whose project is cancelled before the send time is never sent (control)", async () => {
    const { a, p, c, sent } = await approvedCampaign("QA M1 CancelledLater", { scheduledAt: new Date(Date.now() + 7 * DAY) });
    await launchCampaign(a.ctx, c.id);
    await setProjectStatus(a.ctx, p.id, "CANCELLED");
    await adminDb().invitationCampaign.update({ where: { id: c.id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    await kickOutbox(a.orgId);
    expect(await sent()).toBe(0);
  });

  // F-03 residual (fixed at the M1 gate): the send time is part of what the approval binds.
  it("[F-03 residual] pulling an approved, scheduled send forward to 'now' needs a fresh approval", async () => {
    const { a, c, save, sent } = await approvedCampaign("QA M1 PullForward", { scheduledAt: new Date(Date.now() + 7 * DAY) });
    await launchCampaign(a.ctx, c.id);
    await save(a.ctx, { scheduledAt: null }).catch(() => undefined); // same content, send time removed
    await kickOutbox(a.orgId);
    // EXPECTED: the approver approved a send next week; nothing goes out today without a new decision
    expect(await sent()).toBe(0);
  });
});

describe("QA M1 · F-06 RSVP token edges", () => {
  async function tokenFor(name: string) {
    const { a, c } = await approvedCampaign(name);
    await launchCampaign(a.ctx, c.id);
    const job = await adminDb().messageJob.findFirstOrThrow({ where: { invitation: { campaignId: c.id } } });
    const token = /\/rsvp\/([A-Za-z0-9_-]+)/.exec(job.body)![1];
    const setExpiry = (at: Date) => adminDb().publicToken.update({ where: { id: sha256Hex(token) }, data: { expiresAt: at } });
    return { token, setExpiry };
  }

  it("a token one minute before expiry still works; one second after, nothing is revealed or accepted (control)", async () => {
    const { token, setExpiry } = await tokenFor("QA M1 RsvpEdge");
    await setExpiry(new Date(Date.now() + 60_000));
    expect(await getRsvpPage(token)).not.toBeNull();
    await setExpiry(new Date(Date.now() - 1_000));
    expect(await getRsvpPage(token)).toBeNull();
    await expect(submitRsvp({ token, response: "ATTENDING", guestsCount: 1 }, "127.0.0.31")).rejects.toThrow();
  });

  it("opting out still works on an expired link and suppresses the address (control, by design)", async () => {
    const { token, setExpiry } = await tokenFor("QA M1 RsvpOptOut");
    await setExpiry(new Date(Date.now() - DAY));
    await optOut(token, "127.0.0.32");
    const pt = await adminDb().publicToken.findUniqueOrThrow({ where: { id: sha256Hex(token) } });
    expect(await adminDb().suppressionEntry.count({ where: { organizationId: pt.organizationId } })).toBe(1);
  });
});

describe("QA M1 · F-13 read-model scoping attempts", () => {
  it("a workstream-restricted member cannot open, download from, or read the activity of another workstream's task", async () => {
    const a = await createAgency("QA M1 WsScope");
    const lead = await addMember(a.ctx, "team_lead", "Logistics lead");
    const p = await blankProject(a.ctx);
    const [wsA, wsB] = await withTenant({ orgId: a.orgId }, async (tx) => [
      await tx.workstream.create({ data: { organizationId: a.orgId, projectId: p.id, key: "logistics", name: "لوجستيات", statuses: DEFAULT_STATUSES as never } }),
      await tx.workstream.create({ data: { organizationId: a.orgId, projectId: p.id, key: "board", name: "مجلس", statuses: DEFAULT_STATUSES as never } }),
    ]);
    await upsertProjectMember(a.ctx, member(p.id, lead.userId, "LEAD", { workstreamIds: [wsA.id] }));
    const hidden = await task(a.ctx, p.id, "Board negotiation WS-SECRET", { workstreamId: wsB.id });
    const att = await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => storeAttachment(tx, a.ctx, { projectId: p.id, entityType: "TASK", entityId: hidden.id, fileName: "terms.pdf", declaredType: "application/pdf", body: Buffer.from("%PDF-1.4 terms") }));
    await expect(getTaskDetail(lead.ctx, hidden.id)).rejects.toThrow();
    await expect.soft(signedUrlFor(lead.ctx, att.id), "file on another workstream's task").rejects.toThrow();
    const ov = await getProjectOverview(lead.ctx, p.id);
    expect.soft(JSON.stringify(ov), "overview").not.toContain("WS-SECRET");
    const activity = await listProjectActivity(lead.ctx, p.id).catch(() => []);
    expect.soft(JSON.stringify(activity), "activity feed").not.toContain("WS-SECRET");
  });

  // OPEN — Milestone 1 BLOCKER (S2, F-13 residual): the overview's pending-approvals list is not filtered by finance
  // scope, so PO titles and amounts reach members without finance visibility. Left failing on purpose.
  it("[F-13] a member without finance visibility does not see purchase-order amounts in the project overview", async () => {
    const a = await createAgency("QA M1 FinScope");
    await addMember(a.ctx, "ops_director", "Finance approver");
    const pm2 = await addMember(a.ctx, "project_manager", "PM without finance");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, pm2.userId, "MEMBER"));
    const v = await saveVendor(a.ctx, { name: "Stage Builders", category: "FABRICATION", status: "ACTIVE" });
    const po = await createPurchaseOrder(a.ctx, { projectId: p.id, vendorId: v.id, title: "Main stage FIN-SECRET", budgetCategory: "PRODUCTION", amount: 80_000, vatAmount: 12_000 });
    await submitPurchaseOrder(a.ctx, po.id); // pending approval (≥ threshold)
    const ov = await getProjectOverview(pm2.ctx, p.id);
    expect(ov.finance).toBeNull(); // the finance panel itself is hidden (control) …
    const json = JSON.stringify(ov);
    expect.soft(json, "PO title in the overview").not.toContain("FIN-SECRET");
    expect.soft(json, "PO amount in the overview").not.toMatch(/92[,.]?000/);
  });

  it("a member without VIP visibility does not see protocol guest names in the overview or activity (control)", async () => {
    const a = await createAgency("QA M1 VipScope");
    const pm2 = await addMember(a.ctx, "project_manager", "PM without VIP");
    const p = await blankProject(a.ctx, "Protocol", { templateIds: [await templateId(a, "vip-protocol")], eventStartAt: new Date(Date.now() + 20 * DAY) });
    await upsertProjectMember(a.ctx, member(p.id, pm2.userId, "MEMBER"));
    await saveGuest(a.ctx, { projectId: p.id, nameAr: "معالي الضيف VIP-SECRET", category: "VIP", protocolLevel: 1 });
    const ov = await getProjectOverview(pm2.ctx, p.id);
    expect(JSON.stringify(ov)).not.toContain("VIP-SECRET");
    expect(JSON.stringify(await listProjectActivity(pm2.ctx, p.id))).not.toContain("VIP-SECRET");
  });

  // F-13 residual (fixed at the M1 gate): the follow-up task names the delivery card, not the VIP.
  it("[F-13 residual] a member without VIP visibility does not learn a VIP's name from the failed-delivery follow-up task", async () => {
    const a = await createAgency("QA M1 FollowUpName");
    const pm2 = await addMember(a.ctx, "project_manager", "PM without VIP");
    const p = await blankProject(a.ctx, "Delivery", { templateIds: [await templateId(a, "vip-physical-delivery")], eventStartAt: new Date(Date.now() + 20 * DAY) });
    await upsertProjectMember(a.ctx, member(p.id, pm2.userId, "MEMBER"));
    const campaign = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "PHYSICAL" } }));
    const [r] = await recipients(a, p.id, 1, "صاحب السمو VIPNAME");
    await generateDeliveries(a.ctx, { campaignId: campaign.id, recipientIds: [r.id] });
    const agent = await addMember(a.ctx, "field_agent", "Driver");
    const d = await withTenant({ orgId: a.orgId }, (tx) => tx.delivery.findFirstOrThrow({ where: { projectId: p.id } }));
    await bulkAssign(a.ctx, { projectId: p.id, deliveryIds: [d.id], agentId: agent.userId, overrideCapacity: false });
    await updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "OUT_FOR_DELIVERY", evidenceIds: [], source: "FIELD" });
    await updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "FAILED_ATTEMPT", reason: "NO_ANSWER", evidenceIds: [], source: "FIELD" });
    await processOutbox(a.orgId);
    const list = await listProjectTasks(pm2.ctx, p.id);
    expect(list.tasks.some((t) => t.title.includes("متابعة")), "a follow-up task was created").toBe(true);
    // EXPECTED: data minimisation — the follow-up references the delivery, not the VIP's name
    expect(list.tasks.map((t) => t.title).join(" | ")).not.toContain("VIPNAME");
  });

  it("an org-wide duplicate match does not reveal another project's VIP (control)", async () => {
    const a = await createAgency("QA M1 OrgDup");
    const pm2 = await addMember(a.ctx, "project_manager", "PM of project B");
    const pA = await blankProject(a.ctx, "Project A");
    await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.recipient.create({ data: { organizationId: a.orgId, projectId: pA.id, code: "R-00001", nameAr: "ضيف المشروع أ DUP-SECRET", mobile: "+966551112233", createdById: a.userId } }));
    const pB = await blankProject(pm2.ctx, "Project B", { templateIds: [await templateId(a, "vip-physical-delivery")], eventStartAt: new Date(Date.now() + 20 * DAY) });
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("List");
    ws.addRow(["الاسم", "رقم الجوال", "العنوان", "المدينة"]);
    ws.addRow(["ضيف جديد", "0551112233", "حي النخيل", "الرياض"]);
    const { createImport, getImportPreview, configureAndValidate, listImportRows } = await import("@/server/modules/delivery/imports/service");
    const batch = await createImport(pm2.ctx, { projectId: pB.id, campaignId: null, fileName: "b.xlsx", declaredType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: Buffer.from(await wb.xlsx.writeBuffer()) });
    const pre = await getImportPreview(pm2.ctx, batch.id);
    await configureAndValidate(pm2.ctx, { batchId: batch.id, sheetName: pre.sheetName, headerRow: pre.headerRow, mapping: pre.mapping as Record<string, string>, options: { duplicateScope: "ORGANIZATION", matchOn: ["mobile"], requireMobile: true, requireLocation: true } });
    const rows = await listImportRows(pm2.ctx, batch.id);
    expect(rows.rows[0].status).toBe("DUPLICATE");
    expect(JSON.stringify(rows)).not.toContain("DUP-SECRET");
  });

  it("client search never returns internal task titles (control)", async () => {
    const a = await createAgency("QA M1 ClientSearch");
    const co = await createClientCompany(a, "Sponsor");
    const cl = await clientUser(a, co.id);
    const p = await blankProject(a.ctx, "Sponsor gala", { clientId: co.id });
    await upsertProjectMember(a.ctx, member(p.id, cl.userId, "CLIENT_APPROVER"));
    await task(a.ctx, p.id, "Gala margin SEARCHSECRET");
    const hits = await globalSearch(cl.ctx, "SEARCHSECRET").catch(() => []);
    expect(JSON.stringify(hits)).not.toContain("SEARCHSECRET");
  });
});

describe("QA M1 · F-16 member hierarchy attempts (controls)", () => {
  it("an ops director cannot revoke an owner, change their own role, promote anyone to owner, or suspend themselves", async () => {
    const a = await createAgency("QA M1 Hierarchy");
    const owner2 = await addMember(a.ctx, "owner", "Co-owner");
    const director = await addMember(a.ctx, "ops_director", "Director");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const role = (key: string) => withTenant({ orgId: a.orgId }, (tx) => tx.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key } } }));
    const dirMid = await membershipId(a.orgId, director.userId);
    await expect.soft(setMemberStatus(director.ctx, { membershipId: await membershipId(a.orgId, owner2.userId), status: "REVOKED" }), "revoke owner").rejects.toThrow();
    await expect.soft(changeMemberRole(director.ctx, { membershipId: dirMid, roleId: (await role("owner")).id }), "self-promote").rejects.toThrow();
    await expect.soft(changeMemberRole(director.ctx, { membershipId: await membershipId(a.orgId, pm.userId), roleId: (await role("owner")).id }), "promote PM to owner").rejects.toThrow();
    await expect.soft(setMemberStatus(director.ctx, { membershipId: dirMid, status: "SUSPENDED" }), "suspend self").rejects.toThrow();
  });
});
