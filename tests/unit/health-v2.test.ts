import { describe, expect, it } from "vitest";
import { computeHealth, computeHealthV2, type HealthV2Input } from "@/server/modules/projects/health";

const now = new Date("2026-10-25T09:00:00+03:00");
const event = new Date("2026-11-12T09:00:00+03:00"); // 18 days out

function input(over: Partial<HealthV2Input> = {}): HealthV2Input {
  return {
    now,
    eventStartAt: event,
    deadline: null,
    tasks: { total: 40, done: 10, duePassed: 8, blocked: 0, overdue: [], unownedDueSoon: 0 },
    approvals: { internalOverdue: 0, clientOverdue: 0 },
    milestones: { overdue: 0, blocked: 0 },
    readinessEventsAtRisk: 0,
    incidents: { high: 0, critical: 0 },
    highRisks: 0,
    finance: { overPlanLines: 0, overContract: false },
    ...over,
  };
}

describe("health v2", () => {
  it("scores the PRJ-2026-001 situation as critical with structured, ordered reasons", () => {
    // 0/43 done, 11 overdue (3 high + client-visible, 2 high, 6 medium), 15 unowned due ≤ 7 days,
    // 1 overdue milestone, planned cost above the contract, event in 18 days
    const h = computeHealthV2(input({
      tasks: { total: 43, done: 0, duePassed: 11, blocked: 0, overdue: [{ priority: "HIGH", clientVisible: true, count: 3 }, { priority: "HIGH", clientVisible: false, count: 2 }, { priority: "MEDIUM", clientVisible: false, count: 6 }], unownedDueSoon: 15 },
      milestones: { overdue: 1, blocked: 0 },
      finance: { overPlanLines: 0, overContract: true },
    }));
    // overdue: weight 3·3 + 2·2 + 6·1 = 19 → 57 → capped 30
    // schedule: expected 11/43 = 25.6 %, done 0 %, ×1.5 within 21 days → round(19.19) = 19
    // unowned: 15·3 → capped 15; plan above contract: 15; milestone: 5
    expect(h.reasons.map((r) => [r.key, r.points, r.count])).toEqual([
      ["overdue", 30, 11],
      ["schedule", 19, 11],
      ["unowned", 15, 15],
      ["overContract", 15, 1],
      ["milestones", 5, 1],
    ]);
    expect(h.score).toBe(16);
    expect(h.level).toBe("critical");
    expect(h.atRisk).toBe(true);
    expect(h.schedule.daysToAnchor).toBe(18);
    expect(h.schedule.anchor).toBe("event");
    expect(h.factors).toMatchObject({ overdue: 30, schedule: 19, unowned: 15, overContract: 15, milestones: 5 });
    // v1, given the same project, called it 85 "good" (overdue factor only: round(11/43·60) = 15)
    expect(computeHealth({ totalTasks: 43, doneTasks: 0, overdueTasks: 11, blockedTasks: 0, openHighRisks: 0, blockedMilestones: 0, overdueMilestones: 0, elapsed: null, budgetRatio: null })).toMatchObject({ score: 85, level: "good" });
  });

  it("is still critical for a viewer-independent computation without finance records", () => {
    const h = computeHealthV2(input({
      tasks: { total: 43, done: 0, duePassed: 11, blocked: 0, overdue: [{ priority: "HIGH", clientVisible: true, count: 3 }, { priority: "HIGH", clientVisible: false, count: 2 }, { priority: "MEDIUM", clientVisible: false, count: 6 }], unownedDueSoon: 15 },
      milestones: { overdue: 1, blocked: 0 },
      finance: null,
    }));
    expect(h.score).toBe(100 - 30 - 19 - 15 - 5);
    expect(h.level).toBe("critical");
  });

  it("a project ahead of its due dates is good with no reasons", () => {
    const h = computeHealthV2(input());
    expect(h).toMatchObject({ score: 100, level: "good", atRisk: false, reasons: [] });
    expect(h.schedule.expected).toBeCloseTo(0.2);
    expect(h.schedule.actual).toBeCloseTo(0.25);
  });

  it("anchors on the deadline when there is no event date, and slip costs more within 7 days", () => {
    const deadline = new Date(now.getTime() + 5 * 86_400_000);
    const h = computeHealthV2(input({ eventStartAt: null, deadline, tasks: { total: 10, done: 2, duePassed: 5, blocked: 0, overdue: [{ priority: "MEDIUM", clientVisible: false, count: 3 }], unownedDueSoon: 0 } }));
    expect(h.schedule.anchor).toBe("deadline");
    // slip 0.3 · 50 · 2 = 30 → capped 25; overdue 3·1·3 = 9
    expect(h.reasons.map((r) => [r.key, r.points])).toEqual([["schedule", 25], ["overdue", 9]]);
    expect(h.score).toBe(66);
    expect(h.level).toBe("watch");
  });

  it("a blocker caps the level at watch and flags the project at risk", () => {
    const h = computeHealthV2(input({ incidents: { high: 0, critical: 1 } }));
    expect(h.score).toBe(90);
    expect(h.level).toBe("watch");
    expect(h.atRisk).toBe(true);
    expect(h.reasons[0]).toMatchObject({ key: "incidents", points: 10, count: 1, blocker: true });
  });

  it("shows client delay without blaming the agency, and weights readiness and approvals", () => {
    const h = computeHealthV2(input({ approvals: { internalOverdue: 2, clientOverdue: 3 }, readinessEventsAtRisk: 1, finance: { overPlanLines: 2, overContract: false } }));
    const by = Object.fromEntries(h.reasons.map((r) => [r.key, r]));
    expect(by.clientDelay).toMatchObject({ points: 0, count: 3 });
    expect(by.approvalsOverdue).toMatchObject({ points: 8, count: 2 });
    expect(by.readiness).toMatchObject({ points: 10, count: 1, blocker: true });
    expect(by.overPlan).toMatchObject({ points: 10, count: 2, finance: true });
    expect(h.score).toBe(72);
    expect(h.level).toBe("watch");
    expect(h.atRisk).toBe(true);
  });
});
