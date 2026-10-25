import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { adminDb } from "@/server/db/admin";
import { createProject } from "@/server/modules/projects/service";
import { decideApproval } from "@/server/modules/approvals/service";
import { storeAttachment } from "@/server/modules/files/service";
import { createRevision, getBooth, recordInspection, saveBoqItem, saveBooth, saveSnag, setBoothStage, setSnagStatus, signHandover, submitRevision } from "@/server/modules/booths/service";
import { awardQuote, createRfq, createWorkOrder, listVendors, recordQuote, saveVendor, setWorkOrderStatus, vendorPortal, vendorSchema } from "@/server/modules/vendors/service";
import { createChangeOrder, createExpense, createPurchaseOrder, financeOverview, getProjectFinance, markExpensePaid, requestExpenseApproval, saveBudget, setContractValue, setPurchaseOrderStatus, submitChangeOrder, submitPurchaseOrder } from "@/server/modules/finance/service";
import { addMember, createAgency, ctxFor } from "../helpers";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

async function setup() {
  const a = await createAgency("Production");
  const tpl = (key: string) => withTenant({ orgId: a.orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key } } })).id);
  const { project } = await createProject(a.ctx, { name: "Expo stand", type: "EXHIBITION", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [await tpl("booth-production")], eventStartAt: new Date(Date.now() + 30 * 86400_000) });
  const director = await addMember(a.ctx, "ops_director", "Director");
  return { a, project, director };
}

describe("booth & pavilion production", () => {
  it("stage gates, design approval, BOQ, inspections, snag verification and handover", async () => {
    const { a, project, director } = await setup();
    const booth = await withTenant({ orgId: a.orgId }, (tx) => tx.booth.findFirstOrThrow({ where: { projectId: project.id } }));
    // every booth update and stage move carries the version the user loaded (BUSINESS_RULES §6)
    const ver = () => withTenant({ orgId: a.orgId }, (tx) => tx.booth.findUniqueOrThrow({ where: { id: booth.id } })).then((x) => x.version);

    await expect(setBoothStage(a.ctx, { boothId: booth.id, stage: "PROCUREMENT", version: await ver() })).rejects.toThrow("booths.gateBlocked");
    await expect(saveBooth(a.ctx, { id: booth.id, projectId: project.id, name: booth.name, kind: "BOOTH", permitStatus: "NOT_STARTED", buildStartAt: new Date("2026-12-10"), siteAccessAt: new Date("2026-12-12"), version: await ver() })).rejects.toThrow("errors.validation");

    const rev = await createRevision(a.ctx, { boothId: booth.id, title: "Concept A" });
    await expect(submitRevision(a.ctx, { revisionId: rev.id, approverType: "INTERNAL" })).rejects.toThrow("booths.revisionNeedsFile");
    await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => storeAttachment(tx, a.ctx, { projectId: project.id, entityType: "REVISION", entityId: rev.id, fileName: "concept.png", declaredType: "image/png", body: PNG }));
    const approval = await submitRevision(a.ctx, { revisionId: rev.id, approverType: "INTERNAL" });
    expect((await getBooth(a.ctx, booth.id)).booth.stage).toBe("CLIENT_APPROVAL");
    await decideApproval(director.ctx, { approvalId: approval.id, decision: "APPROVED" });
    let b = await getBooth(a.ctx, booth.id);
    expect(b.booth.stage).toBe("PROCUREMENT"); // approval advances production
    expect(b.nextGates).toContain("booths.gate.boq");

    await saveBoqItem(a.ctx, { boothId: booth.id, code: "S-01", description: "Truss structure", category: "STRUCTURE", unit: "m", quantity: 40, unitCost: 250, committedCost: 0, actualCost: 0, status: "PLANNED" });
    await expect(saveBoqItem(a.ctx, { boothId: booth.id, code: "S-01", description: "Duplicate", category: "STRUCTURE", unit: "m", quantity: 1, unitCost: 1, committedCost: 0, actualCost: 0, status: "PLANNED" })).rejects.toThrow("errors.validation");
    b = await getBooth(a.ctx, booth.id);
    expect(b.totals.estimate).toBe(10000);

    await setBoothStage(a.ctx, { boothId: booth.id, stage: "FABRICATION", version: await ver() });
    await setBoothStage(a.ctx, { boothId: booth.id, stage: "LOGISTICS", version: await ver() });
    await expect(setBoothStage(a.ctx, { boothId: booth.id, stage: "INSTALLATION", version: await ver() })).rejects.toThrow("booths.gateBlocked"); // permit
    await saveBooth(a.ctx, { id: booth.id, projectId: project.id, name: booth.name, kind: "BOOTH", permitStatus: "APPROVED", version: await ver() });
    await setBoothStage(a.ctx, { boothId: booth.id, stage: "INSTALLATION", version: await ver() });
    await expect(setBoothStage(a.ctx, { boothId: booth.id, stage: "LOGISTICS", version: await ver() })).rejects.toThrow("errors.validation"); // back needs reason

    const snag = await saveSnag(a.ctx, { boothId: booth.id, title: "Loose panel", severity: "HIGH" });
    await expect(recordInspection(a.ctx, { boothId: booth.id, type: "SAFETY", result: "FAIL" })).rejects.toThrow("errors.validation");
    for (const type of ["STRUCTURAL", "ELECTRICAL", "SAFETY"] as const) await recordInspection(a.ctx, { boothId: booth.id, type, result: "PASS" });
    await expect(signHandover(a.ctx, { boothId: booth.id, signedBy: "Client rep (synthetic)", version: await ver() })).rejects.toThrow("booths.gateBlocked"); // open HIGH snag
    await setSnagStatus(a.ctx, { id: snag.id, status: "FIXED" });
    await expect(setSnagStatus(a.ctx, { id: snag.id, status: "VERIFIED" })).rejects.toThrow("booths.verifyOwnFix");
    await setSnagStatus(director.ctx, { id: snag.id, status: "VERIFIED" });
    await signHandover(a.ctx, { boothId: booth.id, signedBy: "Client rep (synthetic)", version: await ver() });
    b = await getBooth(a.ctx, booth.id);
    expect(b.booth.stage).toBe("HANDOVER");
    expect(b.readiness.every((r) => r.ok)).toBe(true);
    await setBoothStage(a.ctx, { boothId: booth.id, stage: "LIVE", version: await ver() });

    const other = await createAgency("Other");
    await expect(getBooth(other.ctx, booth.id)).rejects.toThrow();
  });
});

describe("vendors, procurement and finance controls", () => {
  it("RFQ comparison/award, threshold PO approval with SoD, expense evidence, change orders, margin", async () => {
    const { a, project, director } = await setup();
    const v1 = await saveVendor(a.ctx, { name: "مصنع الأفق للمعارض (تجريبي)", category: "FABRICATION", vatNumber: "300000000000003", status: "ACTIVE" });
    const v2 = await saveVendor(a.ctx, { name: "ورشة النخبة (تجريبي)", category: "FABRICATION", status: "ACTIVE" });
    // input validation happens at the action boundary (schema), e.g. Saudi VAT / CR formats
    expect(vendorSchema.safeParse({ name: "Bad VAT", category: "AV", vatNumber: "12345" }).success).toBe(false);
    expect(vendorSchema.safeParse({ name: "Bad CR", category: "AV", crNumber: "12" }).success).toBe(false);

    const rfq = await createRfq(a.ctx, { projectId: project.id, title: "Stand fabrication", vendorIds: [v1.id, v2.id] });
    expect(rfq.code).toMatch(/^RFQ-\d{4}-0001$/);
    const q1 = await recordQuote(a.ctx, { projectId: project.id, rfqId: rfq.id, vendorId: v1.id, amount: 120000, vatAmount: 18000, leadTimeDays: 14 });
    await recordQuote(a.ctx, { projectId: project.id, rfqId: rfq.id, vendorId: v2.id, amount: 100000, vatAmount: 15000, leadTimeDays: 30 });
    await expect(awardQuote(a.ctx, { quoteId: q1.id, budgetCategory: "PRODUCTION" })).rejects.toThrow("errors.validation"); // not lowest → justification
    const award = await awardQuote(a.ctx, { quoteId: q1.id, budgetCategory: "PRODUCTION", justification: "Shorter lead time" });
    expect(award.code).toMatch(/^PO-\d{4}-0001$/);

    // 138,000 ≥ default threshold 50,000 → approval required, requester can't approve
    expect((await submitPurchaseOrder(a.ctx, award.purchaseOrderId)).status).toBe("PENDING_APPROVAL");
    const poApproval = await withTenant({ orgId: a.orgId }, (tx) => tx.approval.findFirstOrThrow({ where: { entityId: award.purchaseOrderId } }));
    await expect(decideApproval(a.ctx, { approvalId: poApproval.id, decision: "APPROVED" })).rejects.toThrow("errors.forbidden");
    await decideApproval(director.ctx, { approvalId: poApproval.id, decision: "APPROVED" });
    await setPurchaseOrderStatus(a.ctx, { id: award.purchaseOrderId, status: "ISSUED" });

    // small PO is approved directly
    const small = await createPurchaseOrder(a.ctx, { projectId: project.id, vendorId: v2.id, title: "Printing", budgetCategory: "PRINTING", amount: 2000, vatAmount: 300 });
    expect((await submitPurchaseOrder(a.ctx, small.id)).status).toBe("APPROVED");

    await saveBudget(a.ctx, { projectId: project.id, category: "PRODUCTION", planned: 110000 });
    await saveBudget(a.ctx, { projectId: project.id, category: "PRINTING", planned: 5000 });
    await setContractValue(a.ctx, { projectId: project.id, contractValue: 200000 });

    // expense needs evidence before approval; SoD again
    const exp = await createExpense(a.ctx, { projectId: project.id, budgetCategory: "LOGISTICS", description: "Forklift rental", amount: 1500, vatAmount: 225, incurredAt: new Date() });
    await expect(requestExpenseApproval(a.ctx, exp.id)).rejects.toThrow("finance.evidenceRequired");
    await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => storeAttachment(tx, a.ctx, { projectId: project.id, entityType: "EXPENSE", entityId: exp.id, fileName: "receipt.png", declaredType: "image/png", body: PNG }));
    const expApproval = await requestExpenseApproval(a.ctx, exp.id);
    await decideApproval(director.ctx, { approvalId: expApproval.id, decision: "APPROVED" });
    await markExpensePaid(a.ctx, exp.id);

    const co = await createChangeOrder(a.ctx, { projectId: project.id, title: "Extra LED wall", amountDelta: 30000, costDelta: 18000, clientVisible: true });
    const coApproval = await submitChangeOrder(a.ctx, { id: co.id, approverType: "INTERNAL" });
    await decideApproval(director.ctx, { approvalId: coApproval.id, decision: "APPROVED" });

    const f = await getProjectFinance(a.ctx, project.id);
    const prod = f.summary.lines.find((l) => l.category === "PRODUCTION")!;
    expect(prod).toMatchObject({ planned: 110000, committed: 120000, actual: 0, overBudget: true });
    expect(f.summary.totals.actual).toBe(1500);
    expect(f.summary.totals.committed).toBe(122000);
    expect(f.summary.contract.revised).toBe(230000);
    // forecast per line = max(planned, committed + unbacked, actual): PRODUCTION 120,000 (over its
    // 110,000 plan), PRINTING 5,000 (plan is the floor over the 2,000 PO), LOGISTICS 1,500; plus the
    // approved change order's 18,000 cost (ASSUMPTIONS #23)
    expect(f.summary.totals.forecast).toBe(120000 + 5000 + 1500 + 18000);
    expect(f.summary.margin?.amount).toBe(230000 - (120000 + 5000 + 1500 + 18000));
    expect(f.purchaseOrders.find((p) => p.id === award.purchaseOrderId)?.status).toBe("ISSUED");

    // finance is hidden from members without finance scope; overview only lists accessible projects
    const pm = await addMember(a.ctx, "project_manager", "PM");
    await withTenant({ orgId: a.orgId }, (tx) => tx.projectMember.create({ data: { organizationId: a.orgId, projectId: project.id, userId: pm.userId, role: "MEMBER" } }));
    await expect(getProjectFinance(pm.ctx, project.id)).rejects.toThrow("errors.forbidden");
    expect((await financeOverview(a.ctx)).projects).toHaveLength(1);

    // work orders: vendor portal sees only its own; agency accepts with rating → vendor performance
    const wo = await createWorkOrder(a.ctx, { projectId: project.id, vendorId: v1.id, title: "Fabricate stand", dueAt: new Date(Date.now() + 86400_000) });
    await createWorkOrder(a.ctx, { projectId: project.id, vendorId: v2.id, title: "Print graphics" });
    const vendorUser = await addMember(a.ctx, "vendor", "Vendor user");
    await withTenant({ orgId: a.orgId }, (tx) => tx.membership.updateMany({ where: { userId: vendorUser.userId }, data: { vendorId: v1.id } }));
    const vctx = await ctxFor(vendorUser.userId, a.slug);
    const portal = await vendorPortal(vctx);
    expect(portal.workOrders.map((w) => w.title)).toEqual(["Fabricate stand"]);
    await expect(setWorkOrderStatus(vctx, { id: wo.id, status: "DELIVERED" })).rejects.toThrow("errors.invalidTransition");
    for (const s of ["ACCEPTED", "IN_PROGRESS", "DELIVERED"] as const) await setWorkOrderStatus(vctx, { id: wo.id, status: s });
    await expect(setWorkOrderStatus(vctx, { id: wo.id, status: "ACCEPTED_BY_AGENCY", rating: 5 })).rejects.toThrow();
    await setWorkOrderStatus(a.ctx, { id: wo.id, status: "ACCEPTED_BY_AGENCY", rating: 4 });
    const perf = (await listVendors(a.ctx)).vendors.find((v) => v.id === v1.id)!.perf;
    expect(perf).toMatchObject({ completed: 1, avgRating: 4, onTimeRate: 1 });

    const codes = await adminDb().purchaseOrder.findMany({ where: { organizationId: a.orgId }, select: { code: true }, orderBy: { code: "asc" } });
    expect(codes.map((c) => c.code.slice(-4))).toEqual(["0001", "0002"]);
  });
});
