import { describe, expect, it } from "vitest";
import type { ServiceContext } from "@/server/authz/context";
import { withTenant } from "@/server/db/tenant";
import { saveBudget, setContractValue } from "@/server/modules/finance/service";
import { myCommitments, operationsBoard, type ExceptionGroup } from "@/server/modules/operations/service";
import { createProjectSchema } from "@/server/modules/projects/schemas";
import { createProject, getProjectOverview, listProjects, setProjectStatus } from "@/server/modules/projects/service";
import { addDependency, createTask, taskInput } from "@/server/modules/tasks/service";
import { addMember, createAgency } from "../helpers";

const DAY = 86_400_000;

async function project(ctx: ServiceContext, name: string) {
  const { project: p } = await createProject(ctx, createProjectSchema.parse({ name, type: "EVENT", eventStartAt: new Date(Date.now() + 18 * DAY) }));
  return p;
}
const task = (ctx: ServiceContext, projectId: string, title: string, dueInDays: number | null, extra: Record<string, unknown> = {}) =>
  createTask(ctx, taskInput.parse({ projectId, title, dueAt: dueInDays === null ? null : new Date(Date.now() + dueInDays * DAY), ...extra }));
const member = (owner: ServiceContext, projectId: string, userId: string, role: "MANAGER" | "MEMBER" = "MEMBER") =>
  withTenant({ orgId: owner.orgId }, (tx) => tx.projectMember.create({ data: { organizationId: owner.orgId, projectId, userId, role, ...(role === "MANAGER" ? { canApprove: true, canViewFinance: true, canExport: true, canViewVip: true } : {}) } }));
const group = (groups: ExceptionGroup[], kind: ExceptionGroup["kind"]) => groups.find((g) => g.kind === kind);

describe("operations board (Today) and My work", () => {
  it("counts match lists, inactive projects are excluded, PMs are scoped and finance is hidden without finance.view", async () => {
    const a = await createAgency("Ops board");
    const director = await addMember(a.ctx, "ops_director", "Director");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const staff = await addMember(a.ctx, "employee", "Staff");

    // A: active, 3 overdue (one critical + client-visible), 2 unowned due in 5 days, 1 task waiting on a late one, plan above contract
    const A = await project(a.ctx, "مشروع أ");
    await member(a.ctx, A.id, staff.userId);
    const late1 = await task(a.ctx, A.id, "Late critical", -3, { priority: "CRITICAL", clientVisible: true });
    await task(a.ctx, A.id, "Late two", -2);
    await task(a.ctx, A.id, "Late mine", -1, { ownerId: staff.userId });
    await task(a.ctx, A.id, "Unowned soon one", 5);
    await task(a.ctx, A.id, "Unowned soon two", 5);
    const waiting = await task(a.ctx, A.id, "Waits on late", 10, { ownerId: a.ctx.userId });
    await addDependency(a.ctx, waiting.id, late1.id);
    await task(a.ctx, A.id, "Mine this week", 3, { ownerId: staff.userId });
    await task(a.ctx, A.id, "Mine undated", null, { ownerId: staff.userId });
    await saveBudget(a.ctx, { projectId: A.id, category: "VENUE", planned: 150_000 });
    await setContractValue(a.ctx, { projectId: A.id, contractValue: 100_000 });

    // B: cancelled with overdue work; C: on hold with overdue work → neither raises exceptions
    const B = await project(a.ctx, "مشروع ب");
    await member(a.ctx, B.id, staff.userId);
    await task(a.ctx, B.id, "Late in cancelled", -2, { ownerId: staff.userId });
    await task(a.ctx, B.id, "Late in cancelled 2", -2);
    await setProjectStatus(a.ctx, B.id, "CANCELLED");
    const C = await project(a.ctx, "مشروع ج");
    await task(a.ctx, C.id, "Late on hold", -2);
    await setProjectStatus(a.ctx, C.id, "ON_HOLD");

    // D: the PM's own project with one overdue task
    const D = await project(pm.ctx, "مشروع د");
    await task(pm.ctx, D.id, "PM late", -4);

    // ── director: org scope ──
    const b = await operationsBoard(director.ctx);
    expect(b.portfolio.map((p) => p.id).sort()).toEqual([A.id, D.id].sort());
    const projectsInRows = new Set(b.exceptions.flatMap((g) => g.rows.map((r) => r.project.id)));
    expect(projectsInRows.has(B.id) || projectsInRows.has(C.id)).toBe(false);

    const overdue = group(b.exceptions, "overdueTask")!;
    expect(overdue.count).toBe(4);
    expect(overdue.rows).toHaveLength(overdue.count);
    expect(overdue.rows[0]).toMatchObject({ title: "Late critical", tone: "danger", owner: null, ownerExpected: true, action: "assign", meta: { priority: "CRITICAL", clientVisible: true, daysLate: 3 } });
    expect(overdue.rows.find((r) => r.title === "Late mine")).toMatchObject({ owner: "Staff", action: "chase" });

    const unowned = group(b.exceptions, "unownedTask")!;
    expect(unowned.count).toBe(2);
    expect(unowned.rows.map((r) => r.title).sort()).toEqual(["Unowned soon one", "Unowned soon two"]);

    const blocked = group(b.exceptions, "blockedTask")!;
    expect(blocked.count).toBe(1);
    expect(blocked.rows[0]).toMatchObject({ title: "Waits on late", meta: { waitingOn: "Late critical" } });

    for (const g of b.exceptions.filter((x) => ["overdueTask", "unownedTask", "blockedTask", "approvalOverdue", "incident", "milestone", "readiness", "overContract"].includes(x.kind))) {
      expect(g.rows.length, g.kind).toBe(g.count);
    }

    const money = group(b.exceptions, "overContract")!;
    expect(money.count).toBe(1);
    expect(money.rows[0]).toMatchObject({ project: { id: A.id }, meta: { planned: 150_000, forecast: 150_000, contract: 100_000, margin: -50_000 } });
    expect(b.signals?.finance).toMatchObject({ contract: 100_000, planned: 150_000 });

    // one health computation: the board, the project overview and the portfolio list agree
    const rowA = b.portfolio.find((p) => p.id === A.id)!;
    const ov = await getProjectOverview(a.ctx, A.id);
    const listed = (await listProjects(a.ctx)).find((p) => p.id === A.id)!;
    for (const h of [ov.health, listed.health]) {
      expect(h.score).toBe(rowA.health.score);
      expect(h.reasons).toEqual(rowA.health.reasons);
    }
    expect(rowA.health.reasons.map((r) => r.key)).toEqual(expect.arrayContaining(["overdue", "unowned", "overContract"]));
    expect(rowA.health.reasons.find((r) => r.key === "overdue")?.count).toBe(3);
    expect(rowA.gaps.unowned).toBe(4); // "Late critical", "Late two" and the two due soon

    // ── PM: only the projects they belong to ──
    const pb = await operationsBoard(pm.ctx);
    expect(pb.portfolio.map((p) => p.id)).toEqual([D.id]);
    expect(group(pb.exceptions, "overdueTask")).toMatchObject({ count: 1, rows: [{ title: "PM late" }] });
    expect(group(pb.exceptions, "overContract")).toBeUndefined();

    // ── employee without finance.view: money is hidden, not zero ──
    const sb = await operationsBoard(staff.ctx);
    expect(sb.portfolio.map((p) => p.id)).toEqual([A.id]);
    expect(sb.portfolio[0].financeVisible).toBe(false);
    expect(group(sb.exceptions, "overContract")).toBeUndefined();
    expect(group(sb.exceptions, "overPlan")).toBeUndefined();
    expect(sb.signals?.finance).toBeNull();

    // ── My work: buckets, and nothing from the cancelled project ──
    const mine = await myCommitments(staff.ctx);
    const titles = (bucket: string) => mine.items.filter((i) => i.bucket === bucket).map((i) => i.title);
    expect(titles("overdue")).toEqual(["Late mine"]);
    expect(titles("week")).toEqual(["Mine this week"]);
    expect(titles("none")).toEqual(["Mine undated"]);
    expect(mine.items.some((i) => i.title === "Late in cancelled")).toBe(false);

    // managers see the ownership gaps of the active projects they manage, and nothing else
    const pmMine = await myCommitments(pm.ctx);
    expect(pmMine.gaps).toMatchObject([{ project: { id: D.id }, unowned: 1 }]);
    const owner = await myCommitments(a.ctx);
    expect(owner.gaps.map((g) => g.project.id)).toEqual([A.id]);
    expect(owner.gaps[0]).toMatchObject({ unowned: 4, unownedSoon: 4 });
  });

  it("an empty agency gets the setup checklist", async () => {
    const a = await createAgency("Fresh");
    const b = await operationsBoard(a.ctx);
    expect(b.projectCount).toBe(0);
    expect(b.portfolio).toEqual([]);
    expect(b.exceptions).toEqual([]);
    expect(b.setup).toMatchObject({ canCreate: true, steps: { client: false, venue: false, team: false, providers: false } });
  });
});
