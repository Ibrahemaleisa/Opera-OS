/**
 * QA gate for Milestone 1 (Agent 5) — the new command loop, validated at the service layer the pages
 * render from: Operations home scoping, approval routing to "Needs you", withdraw, health consistency,
 * honest margin and My work buckets.
 */
import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { withdrawApproval } from "@/server/modules/approvals/service";
import { createPurchaseOrder, getProjectFinance, saveBudget, setContractValue, submitPurchaseOrder } from "@/server/modules/finance/service";
import { myCommitments, operationsBoard } from "@/server/modules/operations/service";
import { getProjectOverview, listProjects, upsertProjectMember } from "@/server/modules/projects/service";
import { saveVendor } from "@/server/modules/vendors/service";
import { addMember, createAgency } from "../../helpers";
import { blankProject, task } from "./qa-helpers";

const DAY = 86_400_000;
const asMember = (projectId: string, userId: string, role: "MANAGER" | "MEMBER", finance = false) => ({ projectId, userId, role, canApprove: false, canExport: false, canViewFinance: finance, canViewVip: false, workstreamIds: [] });

describe("QA M1 · Operations home", () => {
  it("a project manager sees only their own projects, and no money rows without finance visibility", async () => {
    const a = await createAgency("QA M1 OpsScope");
    const pm = await addMember(a.ctx, "project_manager", "PM of B only");
    const pA = await blankProject(a.ctx, "Project A");
    const pB = await blankProject(a.ctx, "Project B");
    await upsertProjectMember(a.ctx, asMember(pB.id, pm.userId, "MEMBER"));
    await task(a.ctx, pA.id, "OPS-A overdue", { dueAt: new Date(Date.now() - 2 * DAY), ownerId: a.userId });
    await task(a.ctx, pB.id, "OPS-B overdue", { dueAt: new Date(Date.now() - 2 * DAY), ownerId: a.userId });
    for (const p of [pA, pB]) {
      await setContractValue(a.ctx, { projectId: p.id, contractValue: 1000 });
      await saveBudget(a.ctx, { projectId: p.id, category: "VENUE", planned: 50_000 });
    }
    const owner = await operationsBoard(a.ctx);
    expect(owner.exceptions.some((g) => g.kind === "overContract" || g.kind === "overPlan"), "owner sees the money exception (control)").toBe(true);
    const board = await operationsBoard(pm.ctx);
    const rows = board.exceptions.flatMap((g) => g.rows);
    expect(rows.every((r) => r.project.id === pB.id), "only project B").toBe(true);
    expect(rows.map((r) => r.title)).toContain("OPS-B overdue");
    expect(board.exceptions.some((g) => g.kind === "overContract" || g.kind === "overPlan"), "no money rows without finance scope").toBe(false);
    expect(board.portfolio.every((p) => p.financeVisible === false)).toBe(true);
    expect(JSON.stringify(board)).not.toMatch(/50[,.]?000/);
  });

  it("a PO approval with no designated approver lands in the director's 'Needs you', not the requester's; withdraw removes it", async () => {
    const a = await createAgency("QA M1 Awaiting");
    const director = await addMember(a.ctx, "ops_director", "Director");
    const p = await blankProject(a.ctx);
    const v = await saveVendor(a.ctx, { name: "AV House", category: "AV", status: "ACTIVE" });
    const po = await createPurchaseOrder(a.ctx, { projectId: p.id, vendorId: v.id, title: "LED wall", budgetCategory: "AV", amount: 80_000, vatAmount: 12_000 });
    expect((await submitPurchaseOrder(a.ctx, po.id)).status).toBe("PENDING_APPROVAL");
    const appr = await withTenant({ orgId: a.orgId }, (tx) => tx.approval.findFirstOrThrow({ where: { entityType: "PURCHASE_ORDER", entityId: po.id, status: "PENDING" } }));
    expect((await operationsBoard(director.ctx)).awaiting.map((x) => x.id)).toContain(appr.id);
    expect((await operationsBoard(a.ctx)).awaiting.map((x) => x.id)).not.toContain(appr.id);
    await withdrawApproval(a.ctx, { approvalId: appr.id, reason: "wrong vendor" });
    expect((await operationsBoard(director.ctx)).awaiting.map((x) => x.id)).not.toContain(appr.id);
    expect((await withTenant({ orgId: a.orgId }, (tx) => tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } }))).status).toBe("DRAFT");
  });

  it("an agency with a single owner gets a clear refusal (not a silent dead end) for above-threshold spend", async () => {
    const a = await createAgency("QA M1 SoloOwner");
    const p = await blankProject(a.ctx);
    const v = await saveVendor(a.ctx, { name: "Stage Co", category: "FABRICATION", status: "ACTIVE" });
    const po = await createPurchaseOrder(a.ctx, { projectId: p.id, vendorId: v.id, title: "Stage", budgetCategory: "PRODUCTION", amount: 80_000, vatAmount: 12_000 });
    await expect(submitPurchaseOrder(a.ctx, po.id)).rejects.toThrow("errors.noEligibleApprover");
  });
});

describe("QA M1 · health and margin", () => {
  it("health is the same on the portfolio, the project overview and the operations board", async () => {
    const a = await createAgency("QA M1 Health");
    const p = await blankProject(a.ctx, "Health project", { eventStartAt: new Date(Date.now() + 10 * DAY) });
    for (let i = 0; i < 6; i++) await task(a.ctx, p.id, `Overdue ${i}`, { dueAt: new Date(Date.now() - (i + 1) * DAY), ownerId: a.userId });
    const portfolio = (await listProjects(a.ctx)).find((x) => x.id === p.id)!.health;
    const overview = (await getProjectOverview(a.ctx, p.id)).health;
    const board = (await operationsBoard(a.ctx)).portfolio.find((x) => x.id === p.id)!.health;
    expect(portfolio.score).toBe(overview.score);
    expect(board.score).toBe(overview.score);
    expect(portfolio.level).toBe(overview.level);
    // 0/6 done, 6 overdue, event in 10 days must not read as "good" (F-11)
    expect(overview.level).not.toBe("good");
  });

  it("margin is never better than the plan allows: a plan above the contract shows a negative margin", async () => {
    const a = await createAgency("QA M1 Margin");
    const p = await blankProject(a.ctx);
    await setContractValue(a.ctx, { projectId: p.id, contractValue: 100_000 });
    await saveBudget(a.ctx, { projectId: p.id, category: "VENUE", planned: 150_000 });
    const f = await getProjectFinance(a.ctx, p.id);
    expect(f.summary.margin?.amount ?? 0).toBeLessThan(0);
  });
});

describe("QA M1 · My work", () => {
  it("own commitments are bucketed overdue / today / week / later", async () => {
    const a = await createAgency("QA M1 MyWork");
    const emp = await addMember(a.ctx, "employee", "Coordinator");
    const p = await blankProject(a.ctx);
    await upsertProjectMember(a.ctx, asMember(p.id, emp.userId, "MEMBER"));
    const at = (h: number) => new Date(Date.now() + h * 3_600_000);
    await task(a.ctx, p.id, "MW overdue", { ownerId: emp.userId, dueAt: at(-30) });
    await task(a.ctx, p.id, "MW week", { ownerId: emp.userId, dueAt: at(4 * 24) });
    await task(a.ctx, p.id, "MW later", { ownerId: emp.userId, dueAt: at(40 * 24) });
    await task(a.ctx, p.id, "MW someone else", { ownerId: a.userId, dueAt: at(-30) });
    const mw = await myCommitments(emp.ctx);
    const items = JSON.stringify(mw);
    const bucket = (title: string) => (JSON.parse(items).items as { title: string; bucket: string }[] | undefined)?.find((x) => x.title === title)?.bucket;
    expect(bucket("MW overdue")).toBe("overdue");
    expect(bucket("MW week")).toBe("week");
    expect(bucket("MW later")).toBe("later");
    expect(items).not.toContain("MW someone else");
  });
});
