/**
 * BUSINESS_RULES §4 — approval policy (AP-1 … AP-10), the project's independent-approval flag and
 * the default due date from the approval SLA. Stream L, Milestone 2.
 */
import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { decideApproval, listProjectApprovals, requestApproval, resolveApproverSet } from "@/server/modules/approvals/service";
import { getApprovalSettingsView, setApprovalException, setApprovalPolicy, setApprovalSla } from "@/server/modules/approvals/settings";
import { addAudience, requestCampaignApproval, saveDigitalCampaign } from "@/server/modules/digital/service";
import { createPurchaseOrder, submitPurchaseOrder } from "@/server/modules/finance/service";
import { saveRole } from "@/server/modules/org/service";
import { operationsBoard } from "@/server/modules/operations/service";
import { setIndependentApproval, upsertProjectMember } from "@/server/modules/projects/service";
import { changeTaskStatus } from "@/server/modules/tasks/service";
import { ALL_PERMISSIONS } from "@/server/authz/permissions";
import { addMember, createAgency } from "../../helpers";
import { blankProject, recipients, task, templateId, type Agency } from "../qa-audit/qa-helpers";
import { adminDb, DAY, member, seedVendor, version } from "./fixtures";

const BODY = "{{honorific}} {{name}}، يسرنا دعوتكم. للتأكيد: {{rsvp_link}}";
const JUSTIFY = "Two-person agency: the second partner is on leave until next month";

/** AP-1 setup: a task owned by PM A, approval requested by employee B. */
async function performerSetup(name: string) {
  const a = await createAgency(name);
  const pmA = await addMember(a.ctx, "project_manager", "PM A, who did the work");
  const empB = await addMember(a.ctx, "employee", "Coordinator B");
  const p = await blankProject(a.ctx);
  await upsertProjectMember(a.ctx, member(p.id, pmA.userId, "MANAGER", { canApprove: true }));
  await upsertProjectMember(a.ctx, member(p.id, empB.userId, "MEMBER"));
  const t = await task(a.ctx, p.id, "VIP seating chart", { requiresApproval: true, ownerId: pmA.userId });
  await changeTaskStatus(pmA.ctx, { id: t.id, status: "review" });
  return { a, pmA, empB, p, t };
}

/** AP-2 setup: a campaign written by director D, approval requested by PM P. */
async function authorSetup(name: string) {
  const a = await createAgency(name);
  const director = await addMember(a.ctx, "ops_director", "Director who wrote it");
  const pm = await addMember(a.ctx, "project_manager", "PM");
  const p = await blankProject(a.ctx, name, { templateIds: [await templateId(a, "vip-digital-campaign")], eventStartAt: new Date(Date.now() + 30 * DAY) });
  await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER"));
  const rs = await recipients(a, p.id, 2);
  const draft = await adminDb().invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "DIGITAL" } });
  const c = await saveDigitalCampaign(director.ctx, { id: draft.id, projectId: p.id, name: "Gala invitation", channel: "SMS", bodyTemplate: `${BODY} — written by the director`, rsvpEnabled: true, qrEnabled: false, scheduledAt: null, version: draft.version });
  await addAudience(director.ctx, { campaignId: c.id, recipientIds: rs.map((r) => r.id) });
  const v = (await adminDb().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).version;
  const appr = await requestCampaignApproval(pm.ctx, c.id, v);
  return { a, director, pm, p, c, appr };
}

/** An owner who is the only finance approver, with a project and a vendor. */
async function soloOwner(name: string) {
  const a = await createAgency(name);
  const p = await blankProject(a.ctx);
  const v = await seedVendor(a);
  const po = async (amount: number) => createPurchaseOrder(a.ctx, { projectId: p.id, vendorId: v.id, title: `Stage ${amount}`, budgetCategory: "PRODUCTION", amount, vatAmount: 0 });
  return { a, p, v, po };
}

const enable = (a: Agency, extra: Partial<{ spendCap: number; types: ("PURCHASE_ORDER" | "EXPENSE" | "CAMPAIGN" | "TASK" | "CHANGE_ORDER")[]; expiresAt: Date }> = {}) =>
  setApprovalException(a.ctx, { action: "enable", justification: JUSTIFY, expiresAt: extra.expiresAt ?? new Date(Date.now() + 30 * DAY), types: extra.types ?? ["PURCHASE_ORDER"], spendCap: extra.spendCap ?? 100_000, audienceCap: 500 });

describe("§4.1 default policy (STANDARD)", () => {
  it("AP-1 the task owner may decide when someone else requested ([F-02 residual] #1 rewritten)", async () => {
    const { pmA, empB, p, t } = await performerSetup("AP1");
    const appr = await requestApproval(empB.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Seating chart", approverType: "INTERNAL" });
    expect((await decideApproval(pmA.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).status).toBe("APPROVED");
  });

  it("AP-2 the campaign author may approve when a colleague requested ([F-02 residual] #2 rewritten)", async () => {
    const { director, appr } = await authorSetup("AP2");
    expect((await decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).status).toBe("APPROVED");
  });

  it("the requester still never decides (M1)", async () => {
    const { pmA, p, t } = await performerSetup("AP requester");
    const appr = await requestApproval(pmA.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Seating chart", approverType: "INTERNAL" }).catch(() => null);
    if (appr) await expect(decideApproval(pmA.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toThrow();
  });
});

describe("§4.2 strict policy and the project flag", () => {
  it("AP-3 under STRICT the performer is refused and is not in the approver set", async () => {
    const { a, pmA, empB, p, t } = await performerSetup("AP3");
    await setApprovalPolicy(a.ctx, { policy: "STRICT" });
    const appr = await requestApproval(empB.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Seating chart", approverType: "INTERNAL" });
    await expect(decideApproval(pmA.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const project = await adminDb().project.findUniqueOrThrow({ where: { id: p.id } });
    const set = await withTenant({ orgId: a.orgId }, (tx) => resolveApproverSet(tx, project, appr));
    expect(set.eligible).not.toContain(pmA.userId);
    expect(set.eligible).toContain(a.userId);
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "org.approval_policy" } })).toBe(1);
  });

  it("AP-4 STANDARD org, but the project needs independent approval: the author is refused", async () => {
    const { a, director, p, appr } = await authorSetup("AP4");
    await setIndependentApproval(a.ctx, { projectId: p.id, value: true, version: await version(p.id) });
    await expect(decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("AP rule 6 setting the flag needs project.delete; clearing it needs a reason; both audited", async () => {
    const a = await createAgency("AP6 flag");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER"));
    await expect(setIndependentApproval(pm.ctx, { projectId: p.id, value: true, version: await version(p.id) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await setIndependentApproval(a.ctx, { projectId: p.id, value: true, version: await version(p.id) });
    await expect(setIndependentApproval(a.ctx, { projectId: p.id, value: false, version: await version(p.id) })).rejects.toThrow("errors.reasonRequired");
    await setIndependentApproval(a.ctx, { projectId: p.id, value: false, version: await version(p.id), reason: "Contract amended: no regulator review" });
    expect(await adminDb().auditEvent.count({ where: { entityId: p.id, action: "project.independent_approval" } })).toBe(2);
  });
});

describe("§4.3 small-organisation exception", () => {
  it("AP-5 with the exception off, the only finance approver's own PO is refused with errors.noEligibleApprover", async () => {
    const { a, po } = await soloOwner("AP5");
    const order = await po(80_000);
    await expect(submitPurchaseOrder(a.ctx, order.id)).rejects.toThrow("errors.noEligibleApprover");
  });

  it("AP-6 with the exception on, a PO under the cap is accepted and self-approved only with a justification, visibly", async () => {
    const { a, p, po } = await soloOwner("AP6");
    // a co-owner without finance authority: told about every self-approval, can't decide spend
    const role = await saveRole(a.ctx, { nameAr: "شريك", nameEn: "Partner (no finance)", baseRole: "OWNER", permissions: ALL_PERMISSIONS.filter((x) => !["finance.approve", "finance.view", "finance.manage"].includes(x)) });
    const partner = await addMember(a.ctx, role.key, "Partner");
    await enable(a);
    const order = await po(80_000);
    expect((await submitPurchaseOrder(a.ctx, order.id)).status).toBe("PENDING_APPROVAL");
    const appr = await adminDb().approval.findFirstOrThrow({ where: { entityId: order.id, status: "PENDING" } });
    await expect(decideApproval(a.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideApproval(a.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null, exception: { justification: "  ", confirm: true } })).rejects.toThrow();
    const listed = await listProjectApprovals(a.ctx, p.id);
    expect(listed.approvals.find((x) => x.id === appr.id)?.canSelfApprove).toBe(true);
    const decided = await decideApproval(a.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null, exception: { justification: "Urgent stage order; partner unreachable this week", confirm: true } });
    expect(decided.status).toBe("APPROVED");
    expect(decided.policyException).toBe(true);
    expect(decided.policyExceptionReason).toMatch(/partner unreachable/);
    expect((await adminDb().purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("APPROVED");
    expect(await adminDb().notification.count({ where: { userId: partner.userId, type: "approval.self_approved" } })).toBe(1);
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "approval.self_approved" } })).toBe(1);
    const board = await operationsBoard(a.ctx);
    expect(board.exceptions.find((g) => g.kind === "selfApproved")?.rows.map((r) => r.id)).toContain(appr.id);
    expect((await getApprovalSettingsView(a.ctx)).month.count).toBe(1);
  });

  it("AP-7 a PO above the cap is refused", async () => {
    const { a, po } = await soloOwner("AP7");
    await enable(a);
    const order = await po(120_000);
    await expect(submitPurchaseOrder(a.ctx, order.id)).rejects.toThrow("errors.noEligibleApprover");
  });

  it("AP-8 the exception never applies to client approvals or flagged projects", async () => {
    const { a, p, po } = await soloOwner("AP8");
    await enable(a, { types: ["PURCHASE_ORDER", "TASK"] });
    const t = await task(a.ctx, p.id, "Client sign-off", { requiresApproval: true, clientVisible: true });
    await expect(requestApproval(a.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Sign-off", approverType: "CLIENT" })).rejects.toThrow("errors.noEligibleApprover");
    await setIndependentApproval(a.ctx, { projectId: p.id, value: true, version: await version(p.id) });
    const order = await po(10_000 + 50_000);
    await expect(submitPurchaseOrder(a.ctx, order.id)).rejects.toThrow("errors.noEligibleApprover");
  });

  it("AP-9 after expiry the owner can't self-approve and the request shows 'no eligible approver'", async () => {
    const { a, p, po } = await soloOwner("AP9");
    await enable(a);
    const order = await po(80_000);
    await submitPurchaseOrder(a.ctx, order.id);
    const appr = await adminDb().approval.findFirstOrThrow({ where: { entityId: order.id, status: "PENDING" } });
    const org = await adminDb().organization.findUniqueOrThrow({ where: { id: a.orgId } });
    const settings = org.settings as Record<string, Record<string, unknown>>;
    await adminDb().organization.update({ where: { id: a.orgId }, data: { settings: { ...settings, approvalException: { ...settings.approvalException, expiresAt: new Date(Date.now() - DAY).toISOString() } } } });
    await expect(decideApproval(a.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null, exception: { justification: "Urgent stage order; partner unreachable", confirm: true } })).rejects.toThrow("errors.exceptionNotApplicable");
    const listed = (await listProjectApprovals(a.ctx, p.id)).approvals.find((x) => x.id === appr.id)!;
    expect(listed.noEligibleApprover).toBe(true);
    expect(listed.canSelfApprove).toBe(false);
  });

  it("AP-10 a director can't enable the exception or change the policy", async () => {
    const a = await createAgency("AP10");
    const director = await addMember(a.ctx, "ops_director", "Director");
    await expect(setApprovalException(director.ctx, { action: "enable", justification: JUSTIFY, expiresAt: new Date(Date.now() + 10 * DAY), types: ["PURCHASE_ORDER"], spendCap: 1000, audienceCap: 100 })).rejects.toThrow("errors.ownerOnly");
    await expect(setApprovalPolicy(director.ctx, { policy: "STRICT" })).rejects.toThrow("errors.ownerOnly");
  });

  it("AP-11 the exception is one toggle: on with defaults and no expiry; an end date, when set, must lie ahead", async () => {
    const { a, po } = await soloOwner("AP toggle");
    await setApprovalException(a.ctx, { action: "enable" });
    const settings = (await getApprovalSettingsView(a.ctx)).exception!;
    expect([settings.enabled, settings.expiresAt ?? null, settings.types.length, settings.spendCap]).toEqual([true, null, 8, 250_000]);
    const order = await po(80_000);
    expect((await submitPurchaseOrder(a.ctx, order.id)).status).toBe("PENDING_APPROVAL");
    await expect(setApprovalException(a.ctx, { action: "update", expiresAt: new Date(Date.now() - DAY) })).rejects.toThrow();
    await setApprovalException(a.ctx, { action: "update", types: ["EXPENSE"], spendCap: 10_000 });
    expect((await getApprovalSettingsView(a.ctx)).exception?.types).toEqual(["EXPENSE"]);
    await setApprovalException(a.ctx, { action: "disable" });
    expect((await getApprovalSettingsView(a.ctx)).exceptionActive).toBe(false);
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: { startsWith: "org.approval_exception_" } } })).toBe(3);
  });
});

describe("§3.4 approval SLA", () => {
  it("a request without a due date is due after the organisation's SLA (default 48 h, configurable)", async () => {
    const { a, empB, p, t } = await performerSetup("AP SLA");
    const first = await requestApproval(empB.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Seating chart", approverType: "INTERNAL" });
    expect(Math.round((first.dueAt!.getTime() - first.createdAt.getTime()) / 3_600_000)).toBe(48);
    await setApprovalSla(a.ctx, { hours: 24 });
    const t2 = await task(a.ctx, p.id, "Second", { requiresApproval: true });
    const second = await requestApproval(empB.ctx, { projectId: p.id, entityType: "TASK", entityId: t2.id, title: "Second", approverType: "INTERNAL" });
    expect(Math.round((second.dueAt!.getTime() - second.createdAt.getTime()) / 3_600_000)).toBe(24);
  });
});
