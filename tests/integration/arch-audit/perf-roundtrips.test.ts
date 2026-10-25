/**
 * ARCH-AUDIT probe (Agent 2): counts SQL statements issued per service call by wrapping the pg
 * Client used by the Prisma driver adapter. Asserts that query counts do not grow with the
 * number of projects (N+1). Run with the arch-audit command; prints a table to stdout.
 */
import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { createProject } from "@/server/modules/projects/service";
import { financeOverview } from "@/server/modules/finance/service";
import { orgDashboard } from "@/server/modules/analytics/service";
import { listProjects, getProjectOverview } from "@/server/modules/projects/service";
import { myWork, listProjectTasks } from "@/server/modules/tasks/service";
import { commandCenter } from "@/server/modules/events/service";
import { arrivalsBoard } from "@/server/modules/protocol/service";
import { listBooths } from "@/server/modules/booths/service";
import { listDigitalCampaigns } from "@/server/modules/digital/service";
import { loadServiceContext } from "@/server/authz/load-context";
import { db } from "@/server/db/client";
import { createAgency } from "../../helpers";

let counting = false;
let count = 0;
const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
const original = proto.query;
proto.query = function (this: unknown, ...args: unknown[]) {
  if (counting) count++;
  return original.apply(this, args);
};

async function measure<T>(fn: () => Promise<T>) {
  count = 0;
  counting = true;
  try {
    await fn();
  } finally {
    counting = false;
  }
  return count;
}

let a: Awaited<ReturnType<typeof createAgency>>;
const projectIds: string[] = [];

describe("arch-audit: SQL statements per page-level service call", () => {
  beforeAll(async () => {
    a = await createAgency("ArchPerf");
    for (let i = 0; i < 40; i++) {
      const { project } = await createProject(a.ctx, { name: `Project ${i}`, type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
      projectIds.push(project.id);
    }
  }, 300_000);

  // Fixed in Milestone 2 (BUSINESS_RULES KD-5): finance scope for every project comes from one membership query,
  // evaluated in memory, so financeOverview stays under 30 statements whatever the number of projects.
  it("[arch · financeOverview N+1] KD-5 reports statement counts (40 projects); financeOverview stays under 30", async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    const rows: [string, number][] = [];
    rows.push(["loadServiceContext (every request)", await measure(() => loadServiceContext(user, a.slug))]);
    rows.push(["orgDashboard", await measure(() => orgDashboard(a.ctx))]);
    rows.push(["listProjects (portfolio)", await measure(() => listProjects(a.ctx))]);
    rows.push(["getProjectOverview", await measure(() => getProjectOverview(a.ctx, projectIds[0]))]);
    rows.push(["listProjectTasks", await measure(() => listProjectTasks(a.ctx, projectIds[0]))]);
    rows.push(["myWork", await measure(() => myWork(a.ctx))]);
    rows.push(["commandCenter", await measure(() => commandCenter(a.ctx))]);
    rows.push(["arrivalsBoard", await measure(() => arrivalsBoard(a.ctx))]);
    rows.push(["listBooths (org)", await measure(() => listBooths(a.ctx))]);
    rows.push(["listDigitalCampaigns (org)", await measure(() => listDigitalCampaigns(a.ctx))]);
    const fin = await measure(() => financeOverview(a.ctx));
    rows.push(["financeOverview (40 projects)", fin]);
    rows.push(["empty withTenant() round trip", await measure(() => withTenant({ orgId: a.orgId }, async () => null))]);
    console.log("\n[arch-audit] SQL statements per call\n" + rows.map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join("\n"));
    // KD-5: < 30 statements for 40 projects, constant in the number of projects
    expect(fin).toBeLessThan(30);
  }, 120_000);
});
