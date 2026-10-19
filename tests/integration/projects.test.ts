import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { createProject, getProjectOverview, upsertProjectMember } from "@/server/modules/projects/service";
import { applyTemplateToProject, publishVersion } from "@/server/modules/templates/service";
import { addDependency, changeTaskStatus, createTask, getTaskDetail, listProjectTasks, updateTask } from "@/server/modules/tasks/service";
import { decideApproval, requestApproval } from "@/server/modules/approvals/service";
import { processOutbox } from "@/server/modules/automation/engine";
import { addMember, createAgency } from "../helpers";

async function templateId(ctx: Awaited<ReturnType<typeof createAgency>>["ctx"], key: string) {
  return withTenant({ orgId: ctx.orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: ctx.orgId, key } } })).id);
}

describe("projects & multi-template composition", () => {
  it("creates a conference project composed from VIP delivery + conference templates", async () => {
    const a = await createAgency("Compose");
    const t1 = await templateId(a.ctx, "vip-physical-delivery");
    const t2 = await templateId(a.ctx, "conference");
    const { project, applied } = await createProject(a.ctx, {
      name: "مؤتمر الابتكار", type: "CONFERENCE", priority: "HIGH", currency: "SAR", budgetAmount: 500000, clientPortal: true, venueIds: [], templateIds: [t1, t2],
      startDate: new Date("2026-11-01"), deadline: new Date("2026-12-20"), eventStartAt: new Date("2026-12-15T09:00:00+03:00"),
    });
    expect(project.code).toMatch(/^PRJ-2026-\d{3}$/);
    expect(applied).toHaveLength(2);
    const ov = await getProjectOverview(a.ctx, project.id);
    const keys = ov.workstreams.map((w) => w.key).sort();
    expect(keys).toEqual(["conference-ops", "event-ops", "vip-delivery"]);
    expect(ov.tasks.total).toBeGreaterThan(20);
    expect(ov.campaigns.filter((c) => c.type === "PHYSICAL")).toHaveLength(1);
    expect(ov.events).toHaveLength(1);
    expect(ov.instances.map((i) => i.templateKey).sort()).toEqual(["conference", "vip-physical-delivery"]);
    // dependencies were instantiated within each template instance
    const deps = await withTenant({ orgId: a.orgId }, (tx) => tx.taskDependency.count({ where: { task: { projectId: project.id } } }));
    expect(deps).toBeGreaterThan(10);
    // budget lines derived from template shares
    const budgets = await withTenant({ orgId: a.orgId }, (tx) => tx.budget.findMany({ where: { projectId: project.id } }));
    expect(budgets.length).toBeGreaterThan(0);
  });

  it("resolves workstream key collisions while preserving separate identities", async () => {
    const a = await createAgency("Collide");
    const t = await templateId(a.ctx, "corporate-event");
    const { project } = await createProject(a.ctx, { name: "Two events", type: "EVENT", priority: "MEDIUM", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [t] });
    const r = await applyTemplateToProject(a.ctx, project.id, t);
    expect(r.preview.workstreams[0]).toMatchObject({ key: "event-ops", resolvedKey: "event-ops-2", collision: true });
    const ws = await withTenant({ orgId: a.orgId }, (tx) => tx.workstream.findMany({ where: { projectId: project.id } }));
    expect(ws.map((w) => w.key).sort()).toEqual(["event-ops", "event-ops-2"]);
    expect(new Set(ws.map((w) => w.templateInstanceId)).size).toBe(2);
  });

  it("publishing a new template version does not alter existing projects", async () => {
    const a = await createAgency("Versioning");
    const t = await templateId(a.ctx, "custom-blank");
    const { project } = await createProject(a.ctx, { name: "Pinned", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [t] });
    const before = await withTenant({ orgId: a.orgId }, (tx) => tx.task.count({ where: { projectId: project.id } }));
    await publishVersion(a.ctx, t, { workstreams: [{ key: "general", name: { ar: "عام", en: "General" }, tasks: [{ key: "new-task", title: { ar: "مهمة", en: "New task" } }] }] }, "added task");
    const after = await withTenant({ orgId: a.orgId }, (tx) => tx.task.count({ where: { projectId: project.id } }));
    expect(after).toBe(before);
    const inst = await withTenant({ orgId: a.orgId }, (tx) => tx.templateInstance.findFirstOrThrow({ where: { projectId: project.id } }));
    expect(inst.versionNumber).toBe(1);
    await expect(publishVersion(a.ctx, t, { workstreams: [{ key: "x", name: { ar: "س", en: "x" }, tasks: [{ key: "a", title: { ar: "أ", en: "a" }, dependsOn: ["b"] }, { key: "b", title: { ar: "ب", en: "b" }, dependsOn: ["a"] }] }] })).rejects.toThrow();
  });
});

describe("tasks: workflow rules", () => {
  it("enforces dependencies, approval gating, cycles and optimistic concurrency", async () => {
    const a = await createAgency("Rules");
    const { project } = await createProject(a.ctx, { name: "Rules", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
    const t1 = await createTask(a.ctx, { projectId: project.id, title: "Design", priority: "MEDIUM", requiresApproval: true, clientVisible: false, tags: [] });
    const t2 = await createTask(a.ctx, { projectId: project.id, title: "Print", priority: "MEDIUM", requiresApproval: false, clientVisible: false, tags: [] });
    await addDependency(a.ctx, t2.id, t1.id);
    await expect(addDependency(a.ctx, t1.id, t2.id)).rejects.toThrow("errors.dependencyCycle");
    await expect(changeTaskStatus(a.ctx, { id: t2.id, status: "in_progress" })).rejects.toThrow("errors.blockedByDependencies");
    await expect(changeTaskStatus(a.ctx, { id: t1.id, status: "done" })).rejects.toThrow("errors.approvalRequired");
    // stale version is rejected
    await updateTask(a.ctx, { id: t1.id, title: "Design v2", version: 1 });
    await expect(updateTask(a.ctx, { id: t1.id, title: "Design v3", version: 1 })).rejects.toThrow("errors.conflict");

    const pm = await addMember(a.ctx, "project_manager", "PM");
    await upsertProjectMember(a.ctx, { projectId: project.id, userId: pm.userId, role: "MANAGER", canApprove: true, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    await changeTaskStatus(a.ctx, { id: t1.id, status: "review" });
    const appr = await requestApproval(a.ctx, { projectId: project.id, entityType: "TASK", entityId: t1.id, title: "Approve design", approverType: "INTERNAL" });
    // rejection requires a comment, and the automation reopens the task
    await expect(decideApproval(pm.ctx, { approvalId: appr.id, decision: "REJECTED" })).rejects.toThrow();
    await decideApproval(pm.ctx, { approvalId: appr.id, decision: "REJECTED", comment: "Logo too small" });
    await processOutbox(a.orgId);
    const reopened = await getTaskDetail(a.ctx, t1.id);
    expect(reopened.task.statusCategory).toBe("ACTIVE");
    expect(reopened.approvals[0].decisions.map((d) => d.decision)).toEqual(["PENDING", "REJECTED"]);
    // approve on second round → task in review moves to done
    await changeTaskStatus(a.ctx, { id: t1.id, status: "review" });
    const appr2 = await requestApproval(a.ctx, { projectId: project.id, entityType: "TASK", entityId: t1.id, title: "Approve design v2", approverType: "INTERNAL" });
    await decideApproval(pm.ctx, { approvalId: appr2.id, decision: "APPROVED", comment: null });
    await expect(decideApproval(pm.ctx, { approvalId: appr2.id, decision: "APPROVED" })).rejects.toThrow("errors.conflict");
    expect((await getTaskDetail(a.ctx, t1.id)).task.statusCategory).toBe("DONE");
    await changeTaskStatus(a.ctx, { id: t2.id, status: "in_progress" });
  });

  it("assignment emits notifications through the automation engine", async () => {
    const a = await createAgency("Notify");
    const emp = await addMember(a.ctx, "employee", "Emp");
    const { project } = await createProject(a.ctx, { name: "N", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
    await createTask(a.ctx, { projectId: project.id, title: "Call venue", ownerId: emp.userId, priority: "HIGH", requiresApproval: false, clientVisible: false, tags: [] });
    await processOutbox(a.orgId);
    await processOutbox(a.orgId); // idempotent replay
    const n = await withTenant({ orgId: a.orgId }, (tx) => tx.notification.findMany({ where: { userId: emp.userId } }));
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe("notif.taskAssigned");
  });
});

describe("scoped access", () => {
  it("freelancers see only their assigned tasks; non-members cannot see the project", async () => {
    const a = await createAgency("Scope");
    const fl = await addMember(a.ctx, "freelancer", "Free");
    const emp = await addMember(a.ctx, "employee", "Outsider");
    const { project } = await createProject(a.ctx, { name: "Secret", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
    await upsertProjectMember(a.ctx, { projectId: project.id, userId: fl.userId, role: "FREELANCER", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    const mine = await createTask(a.ctx, { projectId: project.id, title: "Freelance design", ownerId: fl.userId, priority: "LOW", requiresApproval: false, clientVisible: false, tags: [] });
    const other = await createTask(a.ctx, { projectId: project.id, title: "Internal budget", priority: "LOW", requiresApproval: false, clientVisible: false, tags: [] });
    const list = await listProjectTasks(fl.ctx, project.id);
    expect(list.tasks.map((t) => t.id)).toEqual([mine.id]);
    await expect(getTaskDetail(fl.ctx, other.id)).rejects.toThrow("errors.notFound");
    await expect(getProjectOverview(emp.ctx, project.id)).rejects.toThrow("errors.notFound");
    await expect(listProjectTasks(emp.ctx, project.id)).rejects.toThrow("errors.notFound");
    // overview never exposes finance to a freelancer
    const ov = await getProjectOverview(fl.ctx, project.id);
    expect(ov.finance).toBeNull();
  });
});
