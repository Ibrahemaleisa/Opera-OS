import { describe, expect, it } from "vitest";
import { neutralizeFormula, toCsv } from "@/lib/csv";
import { canTransition } from "@/server/modules/delivery/state-machine";
import { computeHealth } from "@/server/modules/projects/health";
import { nextOccurrence, wouldCreateCycle } from "@/server/modules/tasks/service";
import { resolveKey, previewComposition } from "@/server/modules/templates/service";
import { validateDefinition } from "@/server/modules/templates/definition";
import { STARTER_TEMPLATES } from "@/server/modules/templates/starters";
import { matchesConditions } from "@/server/modules/automation/rules";
import { computeProjectScope } from "@/server/authz/policy";
import { SYSTEM_ROLES } from "@/server/authz/roles";
import type { ServiceContext } from "@/server/authz/context";
import { formatDate, formatMoney, formatNumber, formatPercent, parseRiyadhDate, toDateInput } from "@/lib/format";

describe("CSV formula injection", () => {
  it("neutralizes dangerous leading characters", () => {
    expect(neutralizeFormula("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(neutralizeFormula("+966")).toBe("'+966");
    expect(neutralizeFormula("@cmd")).toBe("'@cmd");
    expect(neutralizeFormula("safe")).toBe("safe");
    expect(toCsv(["a"], [["=1+1"]])).toContain("'=1+1");
  });
});

describe("delivery state machine", () => {
  it("allows the happy path and blocks illegal jumps", () => {
    expect(canTransition("READY", "ASSIGNED")).toBe(true);
    expect(canTransition("ASSIGNED", "OUT_FOR_DELIVERY", true)).toBe(true);
    expect(canTransition("OUT_FOR_DELIVERY", "DELIVERED", true)).toBe(true);
    expect(canTransition("READY", "DELIVERED")).toBe(false);
    expect(canTransition("DELIVERED", "READY")).toBe(false);
    expect(canTransition("READY", "ASSIGNED", true)).toBe(false); // agents cannot self-assign
    expect(canTransition("ASSIGNED", "CANCELLED", true)).toBe(false);
  });
});

describe("project health", () => {
  it("is 100 for a clean project and drops for overdue/blocked/risk", () => {
    expect(computeHealth({ totalTasks: 10, doneTasks: 5, overdueTasks: 0, blockedTasks: 0, openHighRisks: 0, blockedMilestones: 0, overdueMilestones: 0, elapsed: 0.4, budgetRatio: 0.5 }).score).toBe(100);
    const bad = computeHealth({ totalTasks: 10, doneTasks: 1, overdueTasks: 5, blockedTasks: 2, openHighRisks: 2, blockedMilestones: 1, overdueMilestones: 0, elapsed: 0.9, budgetRatio: 1.3 });
    expect(bad.level).toBe("critical");
    expect(bad.factors.budget).toBeGreaterThan(0);
  });
});

describe("tasks", () => {
  it("detects dependency cycles", () => {
    const edges = [{ taskId: "b", dependsOnId: "a" }, { taskId: "c", dependsOnId: "b" }];
    expect(wouldCreateCycle(edges, "a", "c")).toBe(true);
    expect(wouldCreateCycle(edges, "c", "a")).toBe(false);
  });
  it("computes recurrence", () => {
    expect(nextOccurrence(new Date("2026-01-31T10:00:00Z"), { freq: "WEEKLY" }).toISOString()).toBe("2026-02-07T10:00:00.000Z");
    expect(nextOccurrence(new Date("2026-01-15T10:00:00Z"), { freq: "MONTHLY", interval: 2 }).toISOString()).toBe("2026-03-15T10:00:00.000Z");
  });
});

describe("templates", () => {
  it("all starter templates are valid", () => {
    for (const t of STARTER_TEMPLATES) {
      const v = validateDefinition(t.definition);
      expect(v.ok, `${t.key}: ${!v.ok && v.errors.join(",")}`).toBe(true);
    }
  });
  it("resolves key collisions deterministically", () => {
    expect(resolveKey("ops", new Set(["ops", "ops-2"]))).toBe("ops-3");
    const p = previewComposition(STARTER_TEMPLATES.find((t) => t.key === "conference")!.definition, ["event-ops"], "conference", 1);
    expect(p.workstreams.find((w) => w.key === "event-ops")?.resolvedKey).toBe("event-ops-2");
  });
});

describe("automation conditions", () => {
  it("matches eq / in / gte", () => {
    expect(matchesConditions({ severity: { in: ["HIGH", "CRITICAL"] } }, { severity: "HIGH" })).toBe(true);
    expect(matchesConditions({ severity: { in: ["HIGH"] } }, { severity: "LOW" })).toBe(false);
    expect(matchesConditions({ attempts: { gte: 2 } }, { attempts: 3 })).toBe(true);
    expect(matchesConditions({ status: "APPROVED" }, { status: "REJECTED" })).toBe(false);
  });
});

describe("authorization policy matrix", () => {
  const project = { id: "p", organizationId: "o", clientPortal: true } as never;
  const ctxFor = (key: string): ServiceContext => {
    const r = SYSTEM_ROLES.find((x) => x.key === key)!;
    return { userId: "u", userName: "", locale: "en", orgId: "o", orgSlug: "o", orgName: "", membershipId: "m", role: r.baseRole, roleKey: r.key, clientId: null, vendorId: null, permissions: new Set(r.permissions), isPlatformAdmin: false };
  };
  const member = (role: string, extra: object = {}) => ({ role, canViewFinance: false, canViewVip: false, canExport: false, canApprove: false, workstreamIds: [], ...extra }) as never;

  it("ops director sees everything incl. finance", () => {
    const s = computeProjectScope(ctxFor("ops_director"), project, null);
    expect(s).toMatchObject({ manage: true, finance: true, vip: true, export: true, taskScope: "all" });
  });
  it("non-member employee cannot see a project", () => {
    expect(() => computeProjectScope(ctxFor("employee"), project, null)).toThrow();
  });
  it("PM member without finance flag cannot see finance; MANAGER can", () => {
    expect(computeProjectScope(ctxFor("project_manager"), project, member("MEMBER")).finance).toBe(false);
    expect(computeProjectScope(ctxFor("project_manager"), project, member("MANAGER")).finance).toBe(true);
  });
  it("freelancer is restricted to assigned tasks", () => {
    expect(computeProjectScope(ctxFor("freelancer"), project, member("FREELANCER")).taskScope).toBe("assigned");
  });
  it("client sees client view only; approver can approve", () => {
    expect(computeProjectScope(ctxFor("client"), project, member("CLIENT_VIEWER"))).toMatchObject({ clientView: true, approve: false, finance: false });
    expect(computeProjectScope(ctxFor("client_approver"), project, member("CLIENT_APPROVER")).approve).toBe(true);
    expect(() => computeProjectScope(ctxFor("client"), { ...(project as object), clientPortal: false } as never, member("CLIENT_VIEWER"))).toThrow();
  });
  it("field agent is field-only", () => {
    expect(computeProjectScope(ctxFor("field_agent"), project, member("FIELD_AGENT"))).toMatchObject({ fieldOnly: true, vip: false });
  });
});

describe("Saudi formatting", () => {
  it("formats SAR and Riyadh dates, Gregorian and Hijri", () => {
    expect(formatMoney(1500, { locale: "en" })).toContain("1,500.00");
    expect(toDateInput(parseRiyadhDate("2026-12-15"))).toBe("2026-12-15");
    expect(formatDate("2026-12-15T22:30:00Z", { locale: "en" })).toBe("16 Dec 2026"); // Riyadh is UTC+3
    expect(formatDate("2026-12-15T09:00:00Z", { locale: "en", calendar: "islamic-umalqura" })).toMatch(/1448/);
  });

  it("emits no bidi marks, so server and browser render identical text", () => {
    const marks = /[\u200e\u200f\u061c]/;
    for (const s of [formatMoney(102800, { locale: "ar", compact: true }), formatMoney(1500, { locale: "ar" }), formatNumber(-12, { locale: "ar" }), formatPercent(0.5, { locale: "ar" })]) {
      expect(s).not.toMatch(marks);
    }
    expect(formatMoney(102800, { locale: "ar", compact: true })).toContain("102.8");
  });
});
