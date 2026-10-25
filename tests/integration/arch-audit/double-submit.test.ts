/**
 * ARCH-AUDIT probes (Agent 2): double-submit / concurrent-request safety of state transitions
 * that use check-then-insert instead of a constraint or compare-and-set.
 */
import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { createProject } from "@/server/modules/projects/service";
import { createTask } from "@/server/modules/tasks/service";
import { requestApproval } from "@/server/modules/approvals/service";
import { configureAndValidate, createImport } from "@/server/modules/delivery/imports/service";
import { addMember, createAgency } from "../../helpers";

describe("arch-audit: double submit", () => {
  it("two concurrent approval requests for the same task leave exactly one PENDING approval", async () => {
    const a = await createAgency("ArchDouble");
    const { project } = await createProject(a.ctx, { name: "P", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
    const t = await createTask(a.ctx, { projectId: project.id, title: "Gated", priority: "LOW", requiresApproval: true, clientVisible: false, tags: [] });
    await addMember(a.ctx, "ops_director", "Director"); // an eligible approver must exist at request time
    const req = () => requestApproval(a.ctx, { projectId: project.id, entityType: "TASK", entityId: t.id, title: "ok?", approverType: "INTERNAL" }).catch(() => null);
    await Promise.all(Array.from({ length: 8 }, req));
    const n = await withTenant({ orgId: a.orgId }, (tx) => tx.approval.count({ where: { entityType: "TASK", entityId: t.id, status: "PENDING" } }));
    expect(n).toBe(1);
  });

  it("double-clicking 'validate' on an import ends VALIDATED with one row per sheet row", async () => {
    const a = await createAgency("ArchDoubleImport");
    const { project } = await createProject(a.ctx, { name: "P", type: "VIP_DELIVERY", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
    const lines = ["الاسم,الجوال,العنوان,المدينة", ...Array.from({ length: 400 }, (_, i) => `ضيف ${i},05${String(50000000 + i)},حي ${i},الرياض`)];
    const batch = await createImport(a.ctx, { projectId: project.id, campaignId: null, fileName: "big.csv", declaredType: "text/csv", body: Buffer.from(lines.join("\n"), "utf8") });
    const go = () => configureAndValidate(a.ctx, { batchId: batch.id, sheetName: batch.sheetName!, headerRow: batch.headerRow, mapping: { nameAr: "الاسم", mobile: "الجوال", address: "العنوان", city: "المدينة" }, options: { duplicateScope: "PROJECT", matchOn: ["mobile"], requireMobile: true, requireLocation: true } }).catch((e: Error) => e.message);
    await Promise.all([go(), go()]);
    const after = await withTenant({ orgId: a.orgId }, async (tx) => ({ b: await tx.importBatch.findUniqueOrThrow({ where: { id: batch.id } }), rows: await tx.importRow.count({ where: { batchId: batch.id } }) }));
    expect({ status: after.b.status, rows: after.rows }).toEqual({ status: "VALIDATED", rows: 400 });
  });

});
