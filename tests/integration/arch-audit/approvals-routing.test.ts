/**
 * Regression tests for approval routing (Stream 1 fix of A1–A4 / product P1 rules 1, 2, 5, 6).
 */
import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { createProject, saveDeliverable, setProjectStatus, upsertProjectMember } from "@/server/modules/projects/service";
import { changeTaskStatus, createTask } from "@/server/modules/tasks/service";
import { decideApproval, listApprovalsAwaitingDecision, requestApproval, withdrawApproval } from "@/server/modules/approvals/service";
import { processOutbox } from "@/server/modules/automation/engine";
import { addMember, createAgency } from "../../helpers";

process.env.RATE_LIMIT_MULTIPLIER ??= "50";
const member = (projectId: string, userId: string, role: "MANAGER" | "MEMBER", canApprove = false) => ({ projectId, userId, role, canApprove, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });

async function setup() {
  const a = await createAgency("ArchRouting");
  const { project } = await createProject(a.ctx, { name: "P", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
  const pm1 = await addMember(a.ctx, "project_manager", "PM one");
  const pm2 = await addMember(a.ctx, "project_manager", "PM two");
  const emp = await addMember(a.ctx, "employee", "Employee");
  await upsertProjectMember(a.ctx, member(project.id, pm1.userId, "MANAGER", true));
  await upsertProjectMember(a.ctx, member(project.id, pm2.userId, "MANAGER", true));
  await upsertProjectMember(a.ctx, member(project.id, emp.userId, "MEMBER"));
  return { a, project, pm1, pm2, emp };
}

describe("arch-audit: approval routing", () => {
  it("notifies every eligible approver (not the requester) and lists it as awaiting them", async () => {
    const { a, project, pm1, pm2, emp } = await setup();
    const t = await createTask(pm1.ctx, { projectId: project.id, title: "Gated", priority: "LOW", requiresApproval: true, clientVisible: false, tags: [] });
    await changeTaskStatus(pm1.ctx, { id: t.id, status: "review" });
    const ap = await requestApproval(pm1.ctx, { projectId: project.id, entityType: "TASK", entityId: t.id, title: "Sign-off", approverType: "INTERNAL" });
    await processOutbox(a.orgId);
    const notified = await withTenant({ orgId: a.orgId }, (tx) => tx.notification.findMany({ where: { type: "approval.requested", entityId: t.id } }));
    const ids = notified.map((n) => n.userId);
    expect(ids).toContain(pm2.userId);
    expect(ids).toContain(a.userId); // the owner holds approve authority on every project
    expect(ids).not.toContain(pm1.userId); // requester
    expect(ids).not.toContain(emp.userId); // no approve scope
    expect((await listApprovalsAwaitingDecision(pm2.ctx)).map((x) => x.id)).toContain(ap.id);
    expect((await listApprovalsAwaitingDecision(pm1.ctx)).map((x) => x.id)).not.toContain(ap.id);
    expect((await listApprovalsAwaitingDecision(emp.ctx)).map((x) => x.id)).not.toContain(ap.id);
    // archived project: no longer awaiting anyone, and the decision is refused
    await setProjectStatus(a.ctx, project.id, "CANCELLED");
    expect((await listApprovalsAwaitingDecision(pm2.ctx)).map((x) => x.id)).not.toContain(ap.id);
    await expect(decideApproval(pm2.ctx, { approvalId: ap.id, decision: "APPROVED" })).rejects.toThrow("errors.projectInactive");
  });

  it("a request nobody else could decide is refused with a clear error", async () => {
    const a = await createAgency("ArchRoutingEmpty");
    const { project } = await createProject(a.ctx, { name: "Solo", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
    const t = await createTask(a.ctx, { projectId: project.id, title: "Gated", priority: "LOW", requiresApproval: true, clientVisible: false, tags: [] });
    await expect(requestApproval(a.ctx, { projectId: project.id, entityType: "TASK", entityId: t.id, title: "x x", approverType: "INTERNAL" })).rejects.toThrow("errors.noEligibleApprover");
  });

  it("withdrawing a pending request reverts the entity and allows a new request", async () => {
    const { a, project, pm1, pm2 } = await setup();
    const d = await saveDeliverable(pm1.ctx, { projectId: project.id, title: "Run of show", status: "IN_PROGRESS", clientVisible: true, requiresApproval: true });
    const ap = await requestApproval(pm1.ctx, { projectId: project.id, entityType: "DELIVERABLE", entityId: d.id, title: "Approve RoS", approverType: "INTERNAL", approverUserId: pm2.userId });
    await expect(withdrawApproval(pm2.ctx, { approvalId: ap.id, reason: "not mine" })).resolves.toBeTruthy(); // project manager may withdraw
    const after = await withTenant({ orgId: a.orgId }, async (tx) => ({ ap: await tx.approval.findUniqueOrThrow({ where: { id: ap.id } }), d: await tx.deliverable.findUniqueOrThrow({ where: { id: d.id } }) }));
    expect(after.ap.status).toBe("CANCELLED");
    expect(after.d.status).toBe("IN_PROGRESS");
    await expect(decideApproval(pm2.ctx, { approvalId: ap.id, decision: "APPROVED" })).rejects.toThrow();
    await expect(requestApproval(pm1.ctx, { projectId: project.id, entityType: "DELIVERABLE", entityId: d.id, title: "Approve RoS again", approverType: "INTERNAL" })).resolves.toBeTruthy();
  });

  it("a designated approver without authority is refused at request time; designation narrows the set", async () => {
    const { project, pm1, pm2, emp } = await setup();
    const t = await createTask(pm1.ctx, { projectId: project.id, title: "Gated", priority: "LOW", requiresApproval: true, clientVisible: false, tags: [] });
    await expect(requestApproval(pm1.ctx, { projectId: project.id, entityType: "TASK", entityId: t.id, title: "x x", approverType: "INTERNAL", approverUserId: emp.userId })).rejects.toThrow("errors.validation");
    const ap = await requestApproval(pm1.ctx, { projectId: project.id, entityType: "TASK", entityId: t.id, title: "to PM two", approverType: "INTERNAL", approverUserId: pm2.userId });
    const owner = (await listApprovalsAwaitingDecision(pm2.ctx)).find((x) => x.id === ap.id);
    expect(owner?.designatedToMe).toBe(true);
  });
});
