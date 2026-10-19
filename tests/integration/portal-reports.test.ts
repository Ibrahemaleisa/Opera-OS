import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { adminDb } from "@/server/db/admin";
import { createProject } from "@/server/modules/projects/service";
import { requestApprovalTx, decideApproval } from "@/server/modules/approvals/service";
import { createChangeRequest, listChangeRequests, portalHome, portalProject, respondChangeRequest } from "@/server/modules/portal/service";
import { buildReport, availableReports } from "@/server/modules/reports/service";
import { listAutomation, setRuleEnabled } from "@/server/modules/automation/admin";
import { changePassword } from "@/server/auth/account";
import { createSession, validateSessionToken } from "@/server/auth/session-store";
import { sha256Hex } from "@/server/auth/crypto";
import { addMember, createAgency, ctxFor } from "../helpers";

describe("client portal", () => {
  it("shows only client-visible, approved progress; client approves; change requests round-trip", async () => {
    const a = await createAgency("Portal");
    const tpl = async (key: string) => withTenant({ orgId: a.orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key } } })).id);
    const { project } = await createProject(a.ctx, { name: "Client gala", type: "EVENT", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [await tpl("corporate-event")], eventStartAt: new Date(Date.now() + 20 * 86400_000) });
    const client = await addMember(a.ctx, "client_approver", "Client approver");
    await withTenant({ orgId: a.orgId }, async (tx) => {
      await tx.projectMember.create({ data: { organizationId: a.orgId, projectId: project.id, userId: client.userId, role: "CLIENT_APPROVER" } });
      // one client-visible task done, one client-visible in review, one internal done
      const ws = await tx.workstream.findFirstOrThrow({ where: { projectId: project.id } });
      const base = { organizationId: a.orgId, projectId: project.id, workstreamId: ws.id, createdById: a.userId, status: "todo" };
      await tx.task.createMany({ data: [
        { ...base, number: 9001, title: "Visible done", clientVisible: true, statusCategory: "DONE" },
        { ...base, number: 9002, title: "Visible in review", clientVisible: true, statusCategory: "REVIEW" },
        { ...base, number: 9003, title: "Internal secret task", clientVisible: false, statusCategory: "DONE" },
      ] });
      await tx.recipient.create({ data: { organizationId: a.orgId, projectId: project.id, code: "R-1", nameAr: "ضيف سري تجريبي", mobile: "+966555000999", createdById: a.userId } });
    });
    const cctx = await ctxFor(client.userId, a.slug);
    const home = await portalHome(cctx);
    expect(home.projects).toHaveLength(1);
    const view = await portalProject(cctx, project.id);
    const titles = view.tasks.map((t) => t.title);
    expect(titles).toContain("Visible done");
    expect(titles).not.toContain("Internal secret task");
    const visible = await withTenant({ orgId: a.orgId }, (tx) => tx.task.count({ where: { projectId: project.id, clientVisible: true } }));
    const visibleDone = await withTenant({ orgId: a.orgId }, (tx) => tx.task.count({ where: { projectId: project.id, clientVisible: true, statusCategory: "DONE" } }));
    expect(view.progress).toMatchObject({ total: visible, done: visibleDone }); // REVIEW is not counted as progress
    expect(JSON.stringify(view)).not.toContain("+966555000999");
    expect(JSON.stringify(view)).not.toContain("ضيف سري");

    // client approval of a client-routed deliverable
    const deliverable = await withTenant({ orgId: a.orgId }, (tx) => tx.deliverable.findFirstOrThrow({ where: { projectId: project.id } }));
    const appr = await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => requestApprovalTx(tx, a.ctx, { projectId: project.id, entityType: "DELIVERABLE", entityId: deliverable.id, title: "Event concept", approverType: "CLIENT", approverUserId: null, description: null, dueAt: null }));
    expect((await portalProject(cctx, project.id)).approvals.find((x) => x.id === appr.id)?.mine).toBe(true);
    await expect(decideApproval(cctx, { approvalId: appr.id, decision: "REJECTED" })).rejects.toThrow("errors.validation"); // comment required
    await decideApproval(cctx, { approvalId: appr.id, decision: "APPROVED", comment: "Looks good" });
    expect((await portalProject(cctx, project.id)).deliverables.find((d) => d.id === deliverable.id)?.status).toBe("APPROVED");

    // change requests: client → agency response → client sees it; agency member can't create as client
    const cr = await createChangeRequest(cctx, { projectId: project.id, title: "Add a VIP lounge", description: "Please add a VIP lounge near hall B" });
    await expect(createChangeRequest(a.ctx, { projectId: project.id, title: "x x x", description: "should fail" })).rejects.toThrow("errors.forbidden");
    await expect(respondChangeRequest(cctx, { id: cr.id, status: "ACCEPTED", response: "self" })).rejects.toThrow();
    await expect(respondChangeRequest(a.ctx, { id: cr.id, status: "ACCEPTED" })).rejects.toThrow("errors.validation");
    await respondChangeRequest(a.ctx, { id: cr.id, status: "ACCEPTED", response: "Added to scope via change order" });
    expect((await listChangeRequests(a.ctx, project.id)).rows[0].status).toBe("ACCEPTED");
    expect((await portalProject(cctx, project.id)).requests[0].response).toContain("change order");
    const notes = await adminDb().notification.findMany({ where: { organizationId: a.orgId, type: { startsWith: "change_request" } } });
    expect(notes.map((n) => n.userId)).toEqual(expect.arrayContaining([a.userId, client.userId]));

    // a client of another project / tenant sees nothing
    const other = await createAgency("Other");
    await expect(portalProject(other.ctx, project.id)).rejects.toThrow();
    const client2 = await addMember(a.ctx, "client", "Other client");
    await expect(portalProject(await ctxFor(client2.userId, a.slug), project.id)).rejects.toThrow();
  });
});

describe("reports, automation admin and account security", () => {
  it("exports respect permissions and neutralise data; rules toggle; password change revokes other sessions", async () => {
    const a = await createAgency("Reports");
    await createProject(a.ctx, { name: "=HYPERLINK(\"http://evil\")", type: "EVENT", priority: "LOW", currency: "SAR", clientPortal: false, venueIds: [], templateIds: [] });
    expect(availableReports(a.ctx)).toEqual(["projects", "tasks", "incidents", "vendors", "finance"]);
    const r = await buildReport(a.ctx, "projects");
    expect(r.rows[0][1]).toBe("=HYPERLINK(\"http://evil\")"); // raw here; toCsv neutralises (unit-tested)
    const employee = await addMember(a.ctx, "employee", "Staff");
    expect(availableReports(employee.ctx)).toEqual([]);
    await expect(buildReport(employee.ctx, "projects")).rejects.toThrow("errors.forbidden");
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "report.export" } })).toBe(1);

    const auto = await listAutomation(a.ctx);
    const rule = auto.rules.find((x) => x.key === "task-assigned-notify")!;
    await setRuleEnabled(a.ctx, { id: rule.id, enabled: false });
    expect((await listAutomation(a.ctx)).rules.find((x) => x.id === rule.id)?.enabled).toBe(false);
    await expect(setRuleEnabled(employee.ctx, { id: rule.id, enabled: true })).rejects.toThrow("errors.forbidden");

    const s1 = await createSession(a.userId, {});
    const s2 = await createSession(a.userId, {});
    await expect(changePassword(a.userId, sha256Hex(s1.token), { current: "wrong-password", next: "Another-Strong-Pass-1" })).rejects.toThrow("errors.validation");
    await expect(changePassword(a.userId, sha256Hex(s1.token), { current: "Sup3r-Secret-Pass", next: "short" })).rejects.toThrow("errors.validation");
    await changePassword(a.userId, sha256Hex(s1.token), { current: "Sup3r-Secret-Pass", next: "Another-Strong-Pass-1" });
    expect(await validateSessionToken(s1.token)).not.toBeNull();
    expect(await validateSessionToken(s2.token)).toBeNull();
  });
});
