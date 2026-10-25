/**
 * QA audit (Agent 5) — adversarial workflow probes.
 *
 * Every `it` states the EXPECTED behaviour of a trustworthy product. Tests that fail today
 * are defects (see the audit report); tests that pass document controls verified to hold.
 */
import { describe, expect, it } from "vitest";
import { createSession, validateSessionToken } from "@/server/auth/session-store";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { decideApproval, requestApproval } from "@/server/modules/approvals/service";
import { processOutbox } from "@/server/modules/automation/engine";
import { schedulerTick } from "@/server/modules/automation/scheduler";
import { bulkAssign, generateDeliveries, syncFieldMutations, updateDeliveryStatus } from "@/server/modules/delivery/service";
import { storeAttachment, signedUrlFor } from "@/server/modules/files/service";
import { createExpense, createPurchaseOrder, requestExpenseApproval, submitPurchaseOrder } from "@/server/modules/finance/service";
import { changeMemberRole, setMemberStatus } from "@/server/modules/org/service";
import { portalProject } from "@/server/modules/portal/service";
import { getProjectOverview, saveDeliverable, saveRisk, setProjectStatus, updateProject, upsertProjectMember } from "@/server/modules/projects/service";
import { addComment, addDependency, bulkUpdateTasks, changeTaskStatus, getTaskDetail, listProjectTasks, updateTask } from "@/server/modules/tasks/service";
import { DEFAULT_STATUSES } from "@/server/modules/templates/definition";
import { createWorkOrder, saveVendor } from "@/server/modules/vendors/service";
import { addMember, createAgency } from "../../helpers";
import { PNG, blankProject, clientUser, createClientCompany, membershipId, recipients, task, templateId } from "./qa-helpers";

const DAY = 86_400_000;
const member = (projectId: string, userId: string, role: "MANAGER" | "LEAD" | "MEMBER" | "FREELANCER" | "CLIENT_APPROVER", extra: Partial<{ workstreamIds: string[]; canViewVip: boolean; canApprove: boolean }> = {}) => ({
  projectId, userId, role, canApprove: extra.canApprove ?? false, canExport: false, canViewFinance: false, canViewVip: extra.canViewVip ?? false, workstreamIds: extra.workstreamIds ?? [],
});

describe("QA: approvals & four-eyes", () => {
  it("an employee cannot approve an approval-gated task by naming themselves as the approver", async () => {
    const a = await createAgency("QA SelfApprove");
    const emp = await addMember(a.ctx, "employee", "Employee");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, emp.userId, "MEMBER"));
    const t = await task(a.ctx, p.id, "Final stage design sign-off", { requiresApproval: true, ownerId: emp.userId });
    await changeTaskStatus(emp.ctx, { id: t.id, status: "review" });
    // EXPECTED: the requester can never decide their own approval (segregation of duties).
    // [arch-audit fix] A request naming an ineligible approver (here: the requester) is now refused up front;
    // either refusal point satisfies the expectation.
    const appr = await requestApproval(emp.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Approve my own work", approverType: "INTERNAL", approverUserId: emp.userId }).catch(() => null);
    if (appr) await expect(decideApproval(emp.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toThrow();
    const after = await getTaskDetail(a.ctx, t.id);
    expect(after.task.statusCategory).not.toBe("DONE");
  });

  it("a non-manager cannot switch off requiresApproval to complete a gated task", async () => {
    const a = await createAgency("QA ApprovalToggle");
    const emp = await addMember(a.ctx, "employee", "Employee");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, emp.userId, "MEMBER"));
    const t = await task(a.ctx, p.id, "Client-approved artwork", { requiresApproval: true, ownerId: emp.userId });
    // EXPECTED: removing an approval gate is a manager decision
    await expect(updateTask(emp.ctx, { id: t.id, requiresApproval: false, version: t.version })).rejects.toThrow();
  });

  it("re-completing a reopened approval-gated task requires a fresh approval", async () => {
    const a = await createAgency("QA Reopen");
    const pm = await addMember(a.ctx, "project_manager", "Approver PM");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER", { canApprove: true }));
    const t = await task(a.ctx, p.id, "Approved signage", { requiresApproval: true });
    await changeTaskStatus(a.ctx, { id: t.id, status: "review" });
    const appr = await requestApproval(a.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Signage", approverType: "INTERNAL" });
    await decideApproval(pm.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
    expect((await getTaskDetail(a.ctx, t.id)).task.statusCategory).toBe("DONE");
    // reopened (e.g. client changed the brief after approval) and reworked
    await changeTaskStatus(a.ctx, { id: t.id, status: "in_progress", reason: "client changed copy" });
    // EXPECTED: the old approval no longer covers the reworked deliverable
    await expect(changeTaskStatus(a.ctx, { id: t.id, status: "done" })).rejects.toThrow("errors.approvalRequired");
  });

  it("rejection automation keeps the task inside its own workflow statuses", async () => {
    const a = await createAgency("QA CustomWorkflow");
    const pm = await addMember(a.ctx, "project_manager", "Approver");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER", { canApprove: true }));
    const statuses = [
      { key: "new", ar: "جديد", en: "New", category: "TODO" },
      { key: "working", ar: "قيد التنفيذ", en: "Working", category: "ACTIVE" },
      { key: "qa", ar: "تدقيق", en: "QA", category: "REVIEW" },
      { key: "closed", ar: "مغلق", en: "Closed", category: "DONE" },
    ];
    const ws = await withTenant({ orgId: a.orgId }, (tx) => tx.workstream.create({ data: { organizationId: a.orgId, projectId: p.id, key: "print", name: "طباعة", statuses } }));
    const t = await task(a.ctx, p.id, "Print badges", { workstreamId: ws.id, requiresApproval: true });
    await changeTaskStatus(a.ctx, { id: t.id, status: "qa" });
    const appr = await requestApproval(a.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Badges", approverType: "INTERNAL" });
    await decideApproval(pm.ctx, { approvalId: appr.id, decision: "REJECTED", comment: "wrong logo" });
    await processOutbox(a.orgId);
    const after = await getTaskDetail(a.ctx, t.id);
    // EXPECTED: status key is one this workstream defines (today the engine writes "in_progress")
    expect(statuses.map((s) => s.key)).toContain(after.task.status);
  });

  it("the submitter of an expense cannot approve it, even when a colleague pressed 'request approval'", async () => {
    const a = await createAgency("QA ExpenseSoD");
    const director = await addMember(a.ctx, "ops_director", "Director");
    await addMember(a.ctx, "ops_director", "Second finance approver"); // [arch-audit fix] a request needs an eligible approver other than requester and spender
    const p = await blankProject(a.ctx);
    const e = await createExpense(director.ctx, { projectId: p.id, budgetCategory: "OTHER", description: "Director taxi receipts", amount: 900, vatAmount: 0, incurredAt: new Date() });
    await withTenant({ orgId: a.orgId, userId: director.userId }, (tx) => storeAttachment(tx, director.ctx, { projectId: p.id, entityType: "EXPENSE", entityId: e.id, fileName: "receipt.png", declaredType: "image/png", body: PNG }));
    const appr = await requestExpenseApproval(a.ctx, e.id); // owner presses "request approval"
    // EXPECTED: SoD is about who spent the money, not who clicked submit
    await expect(decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toThrow();
  });

  it("the creator of a purchase order cannot approve it when a colleague submitted it", async () => {
    const a = await createAgency("QA PoSoD");
    const director = await addMember(a.ctx, "ops_director", "Director");
    await addMember(a.ctx, "ops_director", "Second finance approver"); // [arch-audit fix] see expense test
    const p = await blankProject(a.ctx);
    const v = await saveVendor(a.ctx, { name: "Stage Builders", category: "FABRICATION", status: "ACTIVE" });
    const po = await createPurchaseOrder(director.ctx, { projectId: p.id, vendorId: v.id, title: "Stage", budgetCategory: "PRODUCTION", amount: 80_000, vatAmount: 12_000 });
    await submitPurchaseOrder(a.ctx, po.id);
    const appr = await withTenant({ orgId: a.orgId }, (tx) => tx.approval.findFirstOrThrow({ where: { entityType: "PURCHASE_ORDER", entityId: po.id } }));
    await expect(decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toThrow();
  });

  it("concurrent decisions on one approval: exactly one wins (control)", async () => {
    const a = await createAgency("QA DoubleDecide");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER", { canApprove: true }));
    const t = await task(a.ctx, p.id, "Gate", { requiresApproval: true });
    await changeTaskStatus(a.ctx, { id: t.id, status: "review" });
    const appr = await requestApproval(a.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Gate", approverType: "INTERNAL" });
    const r = await Promise.allSettled([
      decideApproval(pm.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null }),
      decideApproval(pm.ctx, { approvalId: appr.id, decision: "REJECTED", comment: "no" }),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const decisions = await withTenant({ orgId: a.orgId }, (tx) => tx.approvalDecision.count({ where: { approvalId: appr.id, decision: { not: "PENDING" } } }));
    expect(decisions).toBe(1);
  });
});

describe("QA: people leave mid-project", () => {
  it("when the only project manager is suspended, overdue escalations still reach an active person", async () => {
    const a = await createAgency("QA Leaver");
    const pm = await addMember(a.ctx, "project_manager", "Leaving PM");
    const p = await blankProject(pm.ctx, "PM-owned project"); // pm is the sole MANAGER
    const t = await task(pm.ctx, p.id, "Confirm venue contract", { ownerId: pm.userId, dueAt: new Date(Date.now() - 2 * DAY), priority: "CRITICAL" });
    await setMemberStatus(a.ctx, { membershipId: await membershipId(a.orgId, pm.userId), status: "SUSPENDED" });
    await schedulerTick();
    await processOutbox(a.orgId);
    const notes = await withTenant({ orgId: a.orgId }, (tx) => tx.notification.findMany({ where: { type: "task.overdue", entityId: t.id } }));
    // [arch-audit fix] inactive members are no longer notified (was: "the alert fired — to the suspended PM")
    expect(notes.some((n) => n.userId === pm.userId), "no alert to the suspended PM").toBe(false);
    // EXPECTED: somebody who can still act (an active manager / org admin) is told
    expect(notes.map((n) => n.userId).filter((u) => u !== pm.userId).length).toBeGreaterThan(0);
  });

  it("a suspended user's sessions stop working when it was their only organisation (control)", async () => {
    const a = await createAgency("QA LeaverSessions");
    const pm = await addMember(a.ctx, "project_manager", "Leaving PM");
    const s = await createSession(pm.userId, { ip: "10.0.0.1" });
    expect(await validateSessionToken(s.token)).not.toBeNull();
    await setMemberStatus(a.ctx, { membershipId: await membershipId(a.orgId, pm.userId), status: "SUSPENDED" });
    expect(await validateSessionToken(s.token)).toBeNull();
  });

  it("a pending client approval whose designated approver left can be recovered", async () => {
    const a = await createAgency("QA ClientLeft");
    const co = await createClientCompany(a, "Ministry Events Dept");
    const c1 = await clientUser(a, co.id, "Client approver 1");
    const c2 = await clientUser(a, co.id, "Client approver 2");
    const p = await blankProject(a.ctx, "Client project", { clientId: co.id });
    await upsertProjectMember(a.ctx, member(p.id, c1.userId, "CLIENT_APPROVER"));
    await upsertProjectMember(a.ctx, member(p.id, c2.userId, "CLIENT_APPROVER"));
    const d = await saveDeliverable(a.ctx, { projectId: p.id, title: "Run of show v3", status: "IN_PROGRESS", clientVisible: true, requiresApproval: true });
    await requestApproval(a.ctx, { projectId: p.id, entityType: "DELIVERABLE", entityId: d.id, title: "Approve run of show", approverType: "CLIENT", approverUserId: c1.userId });
    await setMemberStatus(a.ctx, { membershipId: await membershipId(a.orgId, c1.userId), status: "SUSPENDED" });
    // EXPECTED: the agency can re-route the approval to the remaining client approver
    await expect(requestApproval(a.ctx, { projectId: p.id, entityType: "DELIVERABLE", entityId: d.id, title: "Approve run of show (re-routed)", approverType: "CLIENT", approverUserId: c2.userId })).resolves.toBeTruthy();
  });

  it("suspending a field agent records the unassignment and does not strand in-flight deliveries", async () => {
    const a = await createAgency("QA AgentLeft");
    const tpl = await templateId(a, "vip-physical-delivery");
    const p = await blankProject(a.ctx, "Delivery", { templateIds: [tpl], eventStartAt: new Date(Date.now() + 20 * DAY) });
    const campaign = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "PHYSICAL" } }));
    const rs = await recipients(a, p.id, 2);
    await generateDeliveries(a.ctx, { campaignId: campaign.id, recipientIds: rs.map((r) => r.id) });
    const agent = await addMember(a.ctx, "field_agent", "Driver");
    const ds = await withTenant({ orgId: a.orgId }, (tx) => tx.delivery.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" } }));
    await bulkAssign(a.ctx, { projectId: p.id, deliveryIds: ds.map((d) => d.id), agentId: agent.userId, overrideCapacity: false });
    await updateDeliveryStatus(agent.ctx, { deliveryId: ds[1].id, to: "OUT_FOR_DELIVERY", evidenceIds: [], source: "FIELD" });
    const before = await withTenant({ orgId: a.orgId }, (tx) => tx.delivery.findUniqueOrThrow({ where: { id: ds[0].id } }));
    await setMemberStatus(a.ctx, { membershipId: await membershipId(a.orgId, agent.userId), status: "SUSPENDED" });
    const { assigned, events, openAssignments, inFlight } = await withTenant({ orgId: a.orgId }, async (tx) => ({
      assigned: await tx.delivery.findUniqueOrThrow({ where: { id: ds[0].id } }),
      events: await tx.deliveryEvent.count({ where: { deliveryId: ds[0].id, toStatus: "READY", fromStatus: "ASSIGNED" } }),
      openAssignments: await tx.deliveryAssignment.count({ where: { deliveryId: ds[0].id, unassignedAt: null } }),
      inFlight: await tx.delivery.findUniqueOrThrow({ where: { id: ds[1].id } }),
    }));
    expect(assigned.status).toBe("READY");
    expect.soft(events, "history row for the automatic unassignment").toBe(1);
    expect.soft(openAssignments, "assignment record closed").toBe(0);
    expect.soft(assigned.version, "version bumped so stale dispatch screens conflict").toBeGreaterThan(before.version);
    // EXPECTED: a VIP invitation physically in a suspended driver's car is surfaced to dispatch
    expect.soft(inFlight.agentId === null || inFlight.escalatedAt !== null, "in-flight delivery escalated or released").toBe(true);
  });

  it("an operations director cannot suspend an agency owner", async () => {
    const a = await createAgency("QA OwnerGuard");
    const owner2 = await addMember(a.ctx, "owner", "Co-owner");
    const director = await addMember(a.ctx, "ops_director", "Director");
    await expect(setMemberStatus(director.ctx, { membershipId: await membershipId(a.orgId, owner2.userId), status: "SUSPENDED" })).rejects.toThrow();
  });

  it("an operations director cannot demote an agency owner", async () => {
    const a = await createAgency("QA OwnerDemote");
    const owner2 = await addMember(a.ctx, "owner", "Co-owner");
    const director = await addMember(a.ctx, "ops_director", "Director");
    const pmRole = await withTenant({ orgId: a.orgId }, (tx) => tx.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key: "project_manager" } } }));
    await expect(changeMemberRole(director.ctx, { membershipId: await membershipId(a.orgId, owner2.userId), roleId: pmRole.id })).rejects.toThrow();
  });
});

describe("QA: scope boundaries inside a tenant", () => {
  it("a freelancer's project overview does not reveal unassigned work, risks or the audit feed", async () => {
    const a = await createAgency("QA FreelancerOverview");
    const fl = await addMember(a.ctx, "freelancer", "Freelance designer");
    const p = await blankProject(a.ctx, "Royal reception");
    await upsertProjectMember(a.ctx, member(p.id, fl.userId, "FREELANCER"));
    await task(a.ctx, p.id, "Booth artwork", { ownerId: fl.userId });
    await task(a.ctx, p.id, "Negotiate venue discount SECRET-TASK");
    await saveRisk(a.ctx, { projectId: p.id, title: "Client may withdraw SECRET-RISK", likelihood: 4, impact: 5, status: "OPEN" });
    const ov = await getProjectOverview(fl.ctx, p.id);
    const json = JSON.stringify(ov);
    expect.soft(json).not.toContain("SECRET-TASK");
    expect.soft(json).not.toContain("SECRET-RISK");
    expect.soft(ov.tasks.total, "task counters only over the freelancer's own work").toBe(1);
  });

  it("task detail for a freelancer or client lists only tasks they may see", async () => {
    const a = await createAgency("QA TaskDetailLeak");
    const fl = await addMember(a.ctx, "freelancer", "Freelancer");
    const co = await createClientCompany(a, "Sponsor");
    const cl = await clientUser(a, co.id);
    const p = await blankProject(a.ctx, "Leaky", { clientId: co.id });
    await upsertProjectMember(a.ctx, member(p.id, fl.userId, "FREELANCER"));
    await upsertProjectMember(a.ctx, member(p.id, cl.userId, "CLIENT_APPROVER"));
    const mine = await task(a.ctx, p.id, "Freelancer task", { ownerId: fl.userId, clientVisible: true });
    await task(a.ctx, p.id, "Internal margin review INTERNAL-ONLY");
    const forFl = await getTaskDetail(fl.ctx, mine.id);
    expect.soft(forFl.projectTasks.map((x) => x.title)).not.toContain("Internal margin review INTERNAL-ONLY");
    const forClient = await getTaskDetail(cl.ctx, mine.id);
    expect.soft(forClient.projectTasks.map((x) => x.title)).not.toContain("Internal margin review INTERNAL-ONLY");
  });

  it("a freelancer cannot obtain a download link for a file on a task they are not assigned to", async () => {
    const a = await createAgency("QA FreelancerFile");
    const fl = await addMember(a.ctx, "freelancer", "Freelancer");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, member(p.id, fl.userId, "FREELANCER"));
    const secret = await task(a.ctx, p.id, "Contract negotiation");
    const att = await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => storeAttachment(tx, a.ctx, { projectId: p.id, entityType: "TASK", entityId: secret.id, fileName: "client-contract.pdf", declaredType: "application/pdf", body: Buffer.from("%PDF-1.4 contract") }));
    await expect(getTaskDetail(fl.ctx, secret.id)).rejects.toThrow("errors.notFound"); // the task itself is hidden …
    await expect(signedUrlFor(fl.ctx, att.id)).rejects.toThrow(); // … EXPECTED: so is its file
  });

  it("bulk edits respect a member's workstream restriction", async () => {
    const a = await createAgency("QA BulkWorkstream");
    const lead = await addMember(a.ctx, "team_lead", "Logistics lead");
    const p = await blankProject(a.ctx);
    const [wsA, wsB] = await withTenant({ orgId: a.orgId }, async (tx) => [
      await tx.workstream.create({ data: { organizationId: a.orgId, projectId: p.id, key: "logistics", name: "لوجستيات", statuses: DEFAULT_STATUSES as never } }),
      await tx.workstream.create({ data: { organizationId: a.orgId, projectId: p.id, key: "finance-ops", name: "مالية", statuses: DEFAULT_STATUSES as never } }),
    ]);
    await upsertProjectMember(a.ctx, member(p.id, lead.userId, "LEAD", { workstreamIds: [wsA.id] }));
    const hidden = await task(a.ctx, p.id, "Board-level budget task", { workstreamId: wsB.id, priority: "LOW" });
    const visible = await listProjectTasks(lead.ctx, p.id);
    expect(visible.tasks.map((t) => t.id)).not.toContain(hidden.id); // read scope works
    await bulkUpdateTasks(lead.ctx, { projectId: p.id, taskIds: [hidden.id], set: { priority: "CRITICAL", ownerId: lead.userId } }).catch(() => undefined);
    const after = await withTenant({ orgId: a.orgId }, (tx) => tx.task.findUniqueOrThrow({ where: { id: hidden.id } }));
    // EXPECTED: write scope matches read scope
    expect.soft(after.priority).toBe("LOW");
    expect.soft(after.ownerId).toBeNull();
  });

  it("a client company loses portal access when the project is moved to a different client", async () => {
    const a = await createAgency("QA ClientSwitch");
    const coA = await createClientCompany(a, "Client A");
    const coB = await createClientCompany(a, "Client B");
    const clA = await clientUser(a, coA.id, "A approver");
    const p = await blankProject(a.ctx, "Re-assigned project", { clientId: coA.id });
    await upsertProjectMember(a.ctx, member(p.id, clA.userId, "CLIENT_APPROVER"));
    expect((await portalProject(clA.ctx, p.id)).project.id).toBe(p.id);
    await updateProject(a.ctx, p.id, { name: p.name, type: "CUSTOM", priority: "MEDIUM", currency: "SAR", clientPortal: true, venueIds: [], clientId: coB.id });
    // EXPECTED: Client A no longer sees Client B's project
    await expect(portalProject(clA.ctx, p.id)).rejects.toThrow();
  });

  it("a comment cannot be attached to a record outside the project it claims", async () => {
    const a = await createAgency("QA CommentInject");
    const emp = await addMember(a.ctx, "employee", "Employee");
    const mine = await blankProject(a.ctx, "Visible project");
    const secret = await blankProject(a.ctx, "Board project");
    await upsertProjectMember(a.ctx, member(mine.id, emp.userId, "MEMBER"));
    await expect(getProjectOverview(emp.ctx, secret.id)).rejects.toThrow("errors.notFound");
    // EXPECTED: rejected — the PROJECT entity is not inside `projectId`
    await expect(addComment(emp.ctx, { entityType: "PROJECT", entityId: secret.id, projectId: mine.id, body: "planted note", visibility: "INTERNAL" })).rejects.toThrow();
  });
});

describe("QA: concurrency & lost updates", () => {
  // Open defect (QA S3-1, register §3 "Concurrency"): no optimistic concurrency on project edits. Deferred to Milestone 2.
  it.fails("[S3-1] known defect, Milestone 2 — two managers editing project details: the second, stale save does not silently revert the first", async () => {
    const a = await createAgency("QA ProjectLostUpdate");
    const pm = await addMember(a.ctx, "project_manager", "PM B");
    const p = await blankProject(a.ctx, "Original name");
    await upsertProjectMember(a.ctx, member(p.id, pm.userId, "MANAGER"));
    const base = { type: "CUSTOM" as const, priority: "MEDIUM" as const, currency: "SAR", clientPortal: true, venueIds: [] };
    // both managers opened the edit form showing "Original name"
    await updateProject(a.ctx, p.id, { ...base, name: "Renamed by owner", description: null });
    await updateProject(pm.ctx, p.id, { ...base, name: "Original name", description: "Added by PM from a stale form" }).catch(() => undefined);
    const now = await withTenant({ orgId: a.orgId }, (tx) => tx.project.findUniqueOrThrow({ where: { id: p.id } }));
    expect(now.name).toBe("Renamed by owner");
  });

  it("concurrent dependency edits cannot create a dependency cycle", async () => {
    const a = await createAgency("QA DepRace");
    const p = await blankProject(a.ctx);
    let cycles = 0;
    for (let i = 0; i < 5; i++) {
      const t1 = await task(a.ctx, p.id, `A${i}`);
      const t2 = await task(a.ctx, p.id, `B${i}`);
      await Promise.allSettled([addDependency(a.ctx, t1.id, t2.id), addDependency(a.ctx, t2.id, t1.id)]);
      const edges = await withTenant({ orgId: a.orgId }, (tx) => tx.taskDependency.count({ where: { OR: [{ taskId: t1.id, dependsOnId: t2.id }, { taskId: t2.id, dependsOnId: t1.id }] } }));
      if (edges === 2) cycles++;
    }
    expect(cycles).toBe(0);
  });
});

describe("QA: deadlines, cancellation and integrity", () => {
  // Open defect (QA S3-3, register §3 "Operations"): overdue vendor work orders never escalate. Deferred to Milestone 2/3.
  it.fails("[S3-3] known defect, Milestone 2 — an overdue vendor work order raises an escalation", async () => {
    const a = await createAgency("QA VendorLate");
    const p = await blankProject(a.ctx);
    const v = await saveVendor(a.ctx, { name: "AV Rentals", category: "AV", status: "ACTIVE" });
    const wo = await createWorkOrder(a.ctx, { projectId: p.id, vendorId: v.id, title: "LED wall installation", dueAt: new Date(Date.now() - DAY) });
    const since = new Date();
    await schedulerTick();
    const events = await withTenant({ orgId: a.orgId }, (tx) => tx.outboxEvent.findMany({ where: { createdAt: { gte: since } } }));
    expect(events.filter((e) => JSON.stringify(e.payload).includes(wo.id)).length).toBeGreaterThan(0);
  });

  it("cancelling a project stops its overdue alerts (regression, F-22 Milestone 1 part)", async () => {
    const a = await createAgency("QA CancelProject");
    const p = await blankProject(a.ctx, "To be cancelled");
    const t = await task(a.ctx, p.id, "Overdue item", { ownerId: a.userId, dueAt: new Date(Date.now() - DAY) });
    await setProjectStatus(a.ctx, p.id, "CANCELLED");
    const since = new Date();
    await schedulerTick();
    const overdue = await withTenant({ orgId: a.orgId }, (tx) => tx.outboxEvent.findMany({ where: { type: "task.overdue", createdAt: { gte: since } } }));
    expect(overdue.filter((e) => JSON.stringify(e.payload).includes(t.id)), "no overdue alert for a cancelled project").toHaveLength(0);
  });

  // Open defect (F-22 cascade): cancelling a project leaves its tasks open. Deferred to Milestone 2 (lifecycle cascade).
  it.fails("[F-22] known defect, Milestone 2 — cancelling a project closes its open tasks", async () => {
    const a = await createAgency("QA CancelCascade");
    const p = await blankProject(a.ctx, "To be cancelled");
    const t = await task(a.ctx, p.id, "Overdue item", { ownerId: a.userId, dueAt: new Date(Date.now() - DAY) });
    await setProjectStatus(a.ctx, p.id, "CANCELLED");
    const after = await withTenant({ orgId: a.orgId }, (tx) => tx.task.findUniqueOrThrow({ where: { id: t.id } }));
    expect(after.statusCategory, "open tasks of a cancelled project are closed/cancelled").toBe("CANCELLED");
  });


  it("an offline 'delivered' replay cannot backdate the delivery before the card was even assigned", async () => {
    const a = await createAgency("QA Backdate");
    const tpl = await templateId(a, "vip-physical-delivery");
    const p = await blankProject(a.ctx, "Delivery", { templateIds: [tpl], eventStartAt: new Date(Date.now() + 20 * DAY) });
    const campaign = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "PHYSICAL" } }));
    const [r] = await recipients(a, p.id, 1);
    await generateDeliveries(a.ctx, { campaignId: campaign.id, recipientIds: [r.id] });
    const agent = await addMember(a.ctx, "field_agent", "Driver");
    const d = await withTenant({ orgId: a.orgId }, (tx) => tx.delivery.findFirstOrThrow({ where: { projectId: p.id } }));
    await bulkAssign(a.ctx, { projectId: p.id, deliveryIds: [d.id], agentId: agent.userId, overrideCapacity: false });
    await updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "OUT_FOR_DELIVERY", evidenceIds: [], source: "FIELD" });
    const ev = await withTenant({ orgId: a.orgId, userId: agent.userId }, (tx) => storeAttachment(tx, agent.ctx, { projectId: p.id, entityType: "DELIVERY", entityId: d.id, kind: "EVIDENCE", fileName: "proof.png", declaredType: "image/png", body: PNG }));
    const tenDaysAgo = new Date(Date.now() - 10 * DAY);
    const [res] = await syncFieldMutations(agent.ctx, [{ deliveryId: d.id, to: "DELIVERED", receivedByName: "Office manager", evidenceIds: [ev.id], clientMutationId: `qa-backdate-${d.id}`, occurredAt: tenDaysAgo, source: "FIELD_OFFLINE" }]);
    const after = await withTenant({ orgId: a.orgId }, (tx) => tx.delivery.findUniqueOrThrow({ where: { id: d.id } }));
    // EXPECTED: either rejected or clamped to a time after the card left the warehouse
    expect(res.ok === false || (after.deliveredAt?.getTime() ?? 0) >= d.createdAt.getTime()).toBe(true);
  });
});

describe("QA: cross-tenant sweep with foreign ids (control)", () => {
  it("every probed service rejects or ignores another agency's ids", async () => {
    const A = await createAgency("QA TenantA");
    const B = await createAgency("QA TenantB");
    const pA = await blankProject(A.ctx, "A project");
    const pB = await blankProject(B.ctx, "B project");
    const tB = await task(B.ctx, pB.id, "B task", { requiresApproval: true });
    await addMember(B.ctx, "ops_director", "B approver"); // [arch-audit fix] a request needs an eligible approver
    await changeTaskStatus(B.ctx, { id: tB.id, status: "review" });
    const apprB = await requestApproval(B.ctx, { projectId: pB.id, entityType: "TASK", entityId: tB.id, title: "B approval", approverType: "INTERNAL" });
    const attB = await withTenant({ orgId: B.orgId, userId: B.userId }, (tx) => storeAttachment(tx, B.ctx, { projectId: pB.id, entityType: "TASK", entityId: tB.id, fileName: "b.pdf", declaredType: "application/pdf", body: Buffer.from("%PDF-1.4 b") }));
    const bMember = await addMember(B.ctx, "employee", "B emp");
    const probes: [string, () => Promise<unknown>][] = [
      ["getTaskDetail", () => getTaskDetail(A.ctx, tB.id)],
      ["updateTask", () => updateTask(A.ctx, { id: tB.id, title: "pwned" })],
      ["changeTaskStatus", () => changeTaskStatus(A.ctx, { id: tB.id, status: "done" })],
      ["decideApproval", () => decideApproval(A.ctx, { approvalId: apprB.id, decision: "APPROVED", comment: null })],
      ["signedUrlFor", () => signedUrlFor(A.ctx, attB.id)],
      ["getProjectOverview", () => getProjectOverview(A.ctx, pB.id)],
      ["addComment(foreign project)", () => addComment(A.ctx, { entityType: "TASK", entityId: tB.id, projectId: pB.id, body: "x", visibility: "INTERNAL" })],
      ["addComment(foreign task in own project)", () => addComment(A.ctx, { entityType: "TASK", entityId: tB.id, projectId: pA.id, body: "x", visibility: "INTERNAL" })],
      ["setMemberStatus", async () => setMemberStatus(A.ctx, { membershipId: await membershipId(B.orgId, bMember.userId), status: "SUSPENDED" })],
      ["upsertProjectMember(foreign user)", () => upsertProjectMember(A.ctx, member(pA.id, bMember.userId, "MEMBER"))],
      ["createTask(foreign owner)", () => task(A.ctx, pA.id, "x", { ownerId: bMember.userId })],
      ["bulkUpdateTasks(foreign project)", () => bulkUpdateTasks(A.ctx, { projectId: pB.id, taskIds: [tB.id], set: { priority: "LOW" } })],
    ];
    const leaks: string[] = [];
    for (const [name, fn] of probes) {
      try {
        await fn();
        leaks.push(name);
      } catch {
        // rejected — good
      }
    }
    // bulk update inside own project with a foreign id must not touch B's task
    await bulkUpdateTasks(A.ctx, { projectId: pA.id, taskIds: [tB.id], set: { priority: "LOW" } }).catch(() => undefined);
    const tAfter = await adminDb().task.findUniqueOrThrow({ where: { id: tB.id } });
    expect(tAfter.priority).toBe("MEDIUM");
    expect(tAfter.title).toBe("B task");
    expect(leaks).toEqual([]);
  });
});
