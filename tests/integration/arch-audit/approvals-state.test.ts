/**
 * ARCH-AUDIT probes (Agent 2, systems architecture). Each test asserts the SAFE / intended
 * behaviour, so a failing test documents a live defect. Run only against a private database:
 *   TEST_DATABASE_URL=... TEST_MIGRATION_DATABASE_URL=... pnpm vitest run tests/integration/arch-audit
 */
import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { createProject, upsertProjectMember } from "@/server/modules/projects/service";
import { changeTaskStatus, createTask, updateTask } from "@/server/modules/tasks/service";
import { decideApproval, requestApproval } from "@/server/modules/approvals/service";
import { createExpense, createPurchaseOrder, setPurchaseOrderStatus } from "@/server/modules/finance/service";
import { saveVendor } from "@/server/modules/vendors/service";
import { cancelCampaign, requestCampaignApproval, saveDigitalCampaign, addAudience } from "@/server/modules/digital/service";
import { processOutbox } from "@/server/modules/automation/engine";
import { statusesOf } from "@/server/modules/tasks/service";
import { addMember, createAgency } from "../../helpers";

async function tplId(orgId: string, key: string) {
  return withTenant({ orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: orgId, key } } })).id);
}

async function base() {
  const a = await createAgency("ArchApprovals");
  const { project } = await createProject(a.ctx, { name: "P", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
  const emp = await addMember(a.ctx, "employee", "Employee");
  await upsertProjectMember(a.ctx, { projectId: project.id, userId: emp.userId, role: "MEMBER", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
  return { a, project, emp };
}

describe("arch-audit: approvals & state machines", () => {
  it("an employee without approval.decide cannot approve their own request by naming themselves approver", async () => {
    const { project, emp } = await base();
    expect(emp.ctx.permissions.has("approval.decide")).toBe(false);
    const task = await createTask(emp.ctx, { projectId: project.id, title: "Gated work", priority: "MEDIUM", requiresApproval: true, clientVisible: false, tags: [], ownerId: emp.userId });
    // SAFE: self-approval (requester === decider, no approval.decide) must be refused — either the request
    // naming an ineligible approver is refused up front, or the decision is (both are acceptable outcomes)
    const approval = await requestApproval(emp.ctx, { projectId: project.id, entityType: "TASK", entityId: task.id, title: "please approve", approverType: "INTERNAL", approverUserId: emp.userId }).catch(() => null);
    if (approval) await expect(decideApproval(emp.ctx, { approvalId: approval.id, decision: "APPROVED" })).rejects.toThrow();
    const after = await withTenant({ orgId: emp.ctx.orgId }, (tx) => tx.task.findUniqueOrThrow({ where: { id: task.id } }));
    expect(after.statusCategory).not.toBe("DONE");
  });

  it("the task owner cannot switch off requiresApproval to skip the approval gate", async () => {
    const { a, project, emp } = await base();
    const task = await createTask(a.ctx, { projectId: project.id, title: "Gated", priority: "MEDIUM", requiresApproval: true, clientVisible: false, tags: [], ownerId: emp.userId });
    await expect(changeTaskStatus(emp.ctx, { id: task.id, status: "done" })).rejects.toThrow("errors.approvalRequired");
    // SAFE: removing the gate should need project-manage authority (or be refused outright)
    await expect(updateTask(emp.ctx, { id: task.id, requiresApproval: false })).rejects.toThrow();
  });

  it("generic requestApproval cannot resurrect a CANCELLED purchase order", async () => {
    const { a, project, emp } = await base();
    const vendor = await saveVendor(a.ctx, { name: "Acme Print", category: "PRINTING", status: "ACTIVE" } as never);
    await createPurchaseOrder(a.ctx, { projectId: project.id, vendorId: vendor.id, title: "Print run", budgetCategory: "PRINTING" as never, amount: 120000, vatAmount: 18000 });
    const po = await withTenant({ orgId: a.orgId }, (tx) => tx.purchaseOrder.findFirstOrThrow({ where: { projectId: project.id } }));
    await setPurchaseOrderStatus(a.ctx, { id: po.id, status: "CANCELLED" });
    // SAFE: an employee (no finance scope) must not be able to put a cancelled PO back into the approval flow
    await expect(requestApproval(emp.ctx, { projectId: project.id, entityType: "PURCHASE_ORDER", entityId: po.id, title: "revive", approverType: "INTERNAL" })).rejects.toThrow();
    const after = await withTenant({ orgId: a.orgId }, (tx) => tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } }));
    expect(after.status).toBe("CANCELLED");
  });

  it("an expense cannot be approved without evidence via the generic approval path", async () => {
    const { a, project, emp } = await base();
    const e = await createExpense(a.ctx, { projectId: project.id, budgetCategory: "PRINTING" as never, description: "Taxi receipts", amount: 900, vatAmount: 0, incurredAt: new Date() });
    // requestExpenseApproval enforces evidence; the generic action does not
    const req = requestApproval(emp.ctx, { projectId: project.id, entityType: "EXPENSE", entityId: e.id, title: "no receipts", approverType: "INTERNAL" });
    const outcome = await req.then((ap) => ap, () => null);
    if (outcome) {
      const director = await addMember(a.ctx, "ops_director", "Director");
      await decideApproval(director.ctx, { approvalId: outcome.id, decision: "APPROVED" }).catch(() => null);
    }
    const after = await withTenant({ orgId: a.orgId }, (tx) => tx.expense.findUniqueOrThrow({ where: { id: e.id } }));
    // SAFE: still not approved (no evidence attached)
    expect(after.status).not.toBe("APPROVED");
  });

  it("approving a campaign that was cancelled while the approval was pending does not revive it", async () => {
    const a = await createAgency("ArchCampaign");
    const { project } = await createProject(a.ctx, { name: "Gala", type: "EVENT", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [await tplId(a.orgId, "vip-digital-campaign")] });
    const r = await withTenant({ orgId: a.orgId }, (tx) => tx.recipient.create({ data: { organizationId: a.orgId, projectId: project.id, code: "R-00001", nameAr: "ضيف", mobile: "+966555000001", createdById: a.userId } }));
    const draft = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: project.id, type: "DIGITAL" } }));
    const c = await saveDigitalCampaign(a.ctx, { id: draft.id, projectId: project.id, name: "Invite", channel: "SMS", bodyTemplate: "مرحبا {{name}} {{rsvp_link}}", rsvpEnabled: true, qrEnabled: false });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [r.id] });
    const director = await addMember(a.ctx, "ops_director", "Director"); // an eligible approver must exist at request time
    const ap = await requestCampaignApproval(a.ctx, c.id);
    await cancelCampaign(a.ctx, c.id);
    await decideApproval(director.ctx, { approvalId: ap.id, decision: "APPROVED" }).catch(() => null);
    const after = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findUniqueOrThrow({ where: { id: c.id } }));
    // SAFE: stays CANCELLED (today the decision blindly sets APPROVED and it can be launched)
    expect(after.status).toBe("CANCELLED");
  });

  it("rejection auto-reopen keeps the task on a status that exists in its workstream workflow", async () => {
    const a = await createAgency("ArchReopen");
    const { project } = await createProject(a.ctx, { name: "Booth", type: "BOOTH", priority: "MEDIUM", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [await tplId(a.orgId, "booth-production")] });
    const ws = await withTenant({ orgId: a.orgId }, (tx) => tx.workstream.findFirstOrThrow({ where: { projectId: project.id } }));
    const statuses = statusesOf(ws);
    const task = await createTask(a.ctx, { projectId: project.id, workstreamId: ws.id, title: "Design", priority: "MEDIUM", requiresApproval: true, clientVisible: false, tags: [] });
    const review = statuses.find((s) => s.category === "REVIEW")!;
    await changeTaskStatus(a.ctx, { id: task.id, status: review.key });
    const director = await addMember(a.ctx, "ops_director", "Director"); // an eligible approver must exist at request time
    const ap = await requestApproval(a.ctx, { projectId: project.id, entityType: "TASK", entityId: task.id, title: "design ok?", approverType: "INTERNAL" });
    await decideApproval(director.ctx, { approvalId: ap.id, decision: "REJECTED", comment: "redo" });
    await processOutbox(a.orgId);
    const after = await withTenant({ orgId: a.orgId }, (tx) => tx.task.findUniqueOrThrow({ where: { id: task.id } }));
    expect(after.statusCategory).toBe("ACTIVE");
    // SAFE: the status key must be one of the workstream's statuses (booth workflow has no "in_progress")
    expect(statuses.map((s) => s.key)).toContain(after.status);
  });
});
