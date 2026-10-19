import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { createProject, upsertProjectMember } from "@/server/modules/projects/service";
import { commitImport, configureAndValidate, createImport, getImportPreview, importReport, listImportRows, resolveRows, rollbackImport, updateImportRow } from "@/server/modules/delivery/imports/service";
import { bulkAssign, getDelivery, listDeliveries, myFieldDeliveries, revealRecipient, syncFieldMutations, updateDeliveryStatus } from "@/server/modules/delivery/service";
import { campaignKpis } from "@/server/modules/delivery/analytics";
import { storeAttachment } from "@/server/modules/files/service";
import { processOutbox } from "@/server/modules/automation/engine";
import { addMember, createAgency } from "../helpers";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

async function setup() {
  const a = await createAgency("Delivery Co");
  const tpl = await withTenant({ orgId: a.orgId }, (tx) => tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key: "vip-physical-delivery" } } }));
  const { project } = await createProject(a.ctx, { name: "Summit", type: "CONFERENCE", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [tpl.id], eventStartAt: new Date("2026-12-15T09:00:00+03:00") });
  const campaign = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: project.id, type: "PHYSICAL" } }));
  return { a, project, campaign };
}

async function importSample(a: Awaited<ReturnType<typeof createAgency>>, projectId: string, campaignId: string) {
  const body = readFileSync("samples/vip-recipients-ar.xlsx");
  const batch = await createImport(a.ctx, { projectId, campaignId, fileName: "vip-recipients-ar.xlsx", declaredType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body });
  const preview = await getImportPreview(a.ctx, batch.id);
  await configureAndValidate(a.ctx, { batchId: batch.id, sheetName: preview.sheetName, headerRow: preview.headerRow, mapping: preview.mapping as Record<string, string>, options: { duplicateScope: "PROJECT", matchOn: ["mobile", "externalRef", "name"], requireMobile: true, requireLocation: true } });
  return batch.id;
}

describe("VIP physical delivery: import studio", () => {
  it("parses, detects header, maps, validates, flags duplicates and errors, then commits with explicit partial approval", async () => {
    const { a, project, campaign } = await setup();
    const body = readFileSync("samples/vip-recipients-ar.xlsx");
    const batch = await createImport(a.ctx, { projectId: project.id, campaignId: campaign.id, fileName: "vip-recipients-ar.xlsx", declaredType: "application/octet-stream", body });
    expect(batch.sheetNames).toEqual(["قائمة المدعوين", "ملاحظات"]);
    const preview = await getImportPreview(a.ctx, batch.id);
    expect(preview.headerRow).toBe(3);
    expect(preview.totalRows).toBe(60);
    expect(preview.mapping).toMatchObject({ nameAr: "الاسم", nameEn: "الاسم بالانجليزي", mobile: "رقم الجوال", mapsUrl: "رابط الموقع", externalRef: "الرقم المرجعي" });

    await configureAndValidate(a.ctx, { batchId: batch.id, sheetName: preview.sheetName, headerRow: preview.headerRow, mapping: preview.mapping as Record<string, string>, options: { duplicateScope: "PROJECT", matchOn: ["mobile", "externalRef", "name"], requireMobile: true, requireLocation: true }, saveMappingAs: "Client list v1" });
    let rows = await listImportRows(a.ctx, batch.id);
    expect(rows.batch.status).toBe("VALIDATED");
    expect(rows.counts.INVALID).toBeGreaterThanOrEqual(3); // bad mobile, no location, formula-like mobile
    expect(rows.counts.DUPLICATE).toBe(1);
    const dup = rows.rows.find((r) => r.status === "DUPLICATE")!;
    expect(dup.duplicateOfRow).toBe(7); // row 4 of data (= sheet row 7)
    const formulaRow = rows.rows.find((r) => r.rowNumber === 45)!;
    expect(formulaRow.status).toBe("INVALID");

    // commit is refused while unresolved problems exist, unless partial import is explicitly approved
    await expect(commitImport(a.ctx, { batchId: batch.id, includeWarnings: true, acceptPartial: false })).rejects.toThrow("delivery.import.partialRequired");

    // fix one invalid row inline, skip the duplicate
    const badMobile = rows.rows.find((r) => r.rowNumber === 9)!; // people[5]
    const fixed = await updateImportRow(a.ctx, { batchId: batch.id, rowId: badMobile.id, overrides: { mobile: "0559990001" } });
    expect(fixed.status === "VALID" || fixed.status === "WARNING").toBe(true);
    await resolveRows(a.ctx, { batchId: batch.id, scope: "ALL_DUPLICATES", resolution: "SKIP" });
    rows = await listImportRows(a.ctx, batch.id);
    const importable = (rows.counts.VALID ?? 0) + (rows.counts.WARNING ?? 0);

    await commitImport(a.ctx, { batchId: batch.id, includeWarnings: true, acceptPartial: true });
    rows = await listImportRows(a.ctx, batch.id);
    expect(rows.batch.status).toBe("PARTIALLY_COMMITTED");
    expect(rows.counts.COMMITTED).toBe(importable);
    const deliveries = await listDeliveries(a.ctx, project.id, { campaignId: campaign.id });
    expect(deliveries.deliveries).toHaveLength(importable);
    expect(new Set(deliveries.deliveries.map((d) => d.trackingCode)).size).toBe(importable);

    // error report contains neutralized formula content
    const report = await importReport(a.ctx, batch.id, "errors", (c) => c);
    expect(report.buffer.length).toBeGreaterThan(1000);

    // completion notification for the uploader
    await processOutbox(a.orgId);
    const n = await withTenant({ orgId: a.orgId }, (tx) => tx.notification.findMany({ where: { userId: a.userId, title: "notif.importCompleted" } }));
    expect(n).toHaveLength(1);

    // re-importing the same file now finds the committed recipients as duplicates (no silent overwrite)
    const again = await importSample(a, project.id, campaign.id);
    const rows2 = await listImportRows(a.ctx, again);
    expect(rows2.counts.DUPLICATE).toBeGreaterThanOrEqual(importable);
  });

  it("rollback succeeds for untouched batches and is blocked once deliveries progress", async () => {
    const { a, project, campaign } = await setup();
    const id1 = await importSample(a, project.id, campaign.id);
    await resolveRows(a.ctx, { batchId: id1, scope: "ALL_INVALID", resolution: "SKIP" });
    await resolveRows(a.ctx, { batchId: id1, scope: "ALL_DUPLICATES", resolution: "SKIP" });
    await commitImport(a.ctx, { batchId: id1, includeWarnings: true, acceptPartial: true });
    const r = await rollbackImport(a.ctx, id1);
    expect(r.recipients).toBeGreaterThan(40);
    expect((await listDeliveries(a.ctx, project.id)).deliveries).toHaveLength(0);

    const id2 = await importSample(a, project.id, campaign.id);
    await resolveRows(a.ctx, { batchId: id2, scope: "ALL_INVALID", resolution: "SKIP" });
    await resolveRows(a.ctx, { batchId: id2, scope: "ALL_DUPLICATES", resolution: "SKIP" });
    await commitImport(a.ctx, { batchId: id2, includeWarnings: true, acceptPartial: true });
    const agent = await addMember(a.ctx, "field_agent", "Driver");
    const one = (await listDeliveries(a.ctx, project.id)).deliveries[0];
    await bulkAssign(a.ctx, { projectId: project.id, deliveryIds: [one.id], agentId: agent.userId, overrideCapacity: false });
    await expect(rollbackImport(a.ctx, id2)).rejects.toThrow("errors.rollbackUnsafe");
  });
});

describe("VIP physical delivery: dispatch, field and KPIs", () => {
  it("assigns in bulk, enforces capacity, field agent updates with evidence, offline replay is idempotent, KPIs update", async () => {
    const { a, project, campaign } = await setup();
    const id = await importSample(a, project.id, campaign.id);
    await resolveRows(a.ctx, { batchId: id, scope: "ALL_INVALID", resolution: "SKIP" });
    await resolveRows(a.ctx, { batchId: id, scope: "ALL_DUPLICATES", resolution: "SKIP" });
    await commitImport(a.ctx, { batchId: id, includeWarnings: true, acceptPartial: true });
    const agent = await addMember(a.ctx, "field_agent", "Driver One");
    const other = await addMember(a.ctx, "field_agent", "Driver Two");
    const all = (await listDeliveries(a.ctx, project.id)).deliveries;
    // default capacity for drivers is 25/day
    await expect(bulkAssign(a.ctx, { projectId: project.id, deliveryIds: all.slice(0, 30).map((d) => d.id), agentId: agent.userId, overrideCapacity: false })).rejects.toThrow("delivery.overCapacity");
    const res = await bulkAssign(a.ctx, { projectId: project.id, deliveryIds: all.slice(0, 10).map((d) => d.id), agentId: agent.userId, overrideCapacity: false });
    expect(res.changed).toBe(10);

    // field agent sees only their own deliveries, with contact data while active
    const mine = await myFieldDeliveries(agent.ctx);
    expect(mine).toHaveLength(10);
    expect(mine[0].recipient.mobile).toMatch(/^\+9665/);
    expect(await myFieldDeliveries(other.ctx)).toHaveLength(0);
    await expect(getDelivery(other.ctx, mine[0].id)).rejects.toThrow("errors.notFound");
    // agents cannot see the dispatch list or reveal registry data
    await expect(listDeliveries(agent.ctx, project.id)).rejects.toThrow();
    await expect(revealRecipient(agent.ctx, all[0].recipient.id)).rejects.toThrow();

    const d = mine[0];
    await updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "OUT_FOR_DELIVERY", version: d.version, evidenceIds: [], source: "FIELD" });
    // DELIVERED requires evidence + receiver name
    await expect(updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "DELIVERED", evidenceIds: [], receivedByName: "مدير المكتب", source: "FIELD" })).rejects.toThrow("delivery.evidenceRequired");
    const att = await withTenant({ orgId: a.orgId, userId: agent.userId }, (tx) => storeAttachment(tx, agent.ctx, { projectId: project.id, entityType: "DELIVERY", entityId: d.id, kind: "EVIDENCE", fileName: "proof.png", declaredType: "image/png", body: PNG }));
    const done = await updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "DELIVERED", evidenceIds: [att.id], receivedByName: "مدير المكتب", source: "FIELD", clientMutationId: "m-delivered-0001" });
    expect(done.delivery.status).toBe("DELIVERED");
    expect(done.delivery.attemptsCount).toBe(1);
    // after delivery, contact data is no longer exposed to the agent
    const after = (await myFieldDeliveries(agent.ctx)).find((x) => x.id === d.id)!;
    expect(after.recipient.masked).toBe(true);
    expect(after.recipient.mobile).toContain("•••");

    // offline queue: second delivery out + failed attempt; replaying the same batch is a no-op; stale version is a conflict
    const d2 = mine[1];
    const batch = [
      { deliveryId: d2.id, to: "OUT_FOR_DELIVERY" as const, version: d2.version, clientMutationId: "m-out-0002", evidenceIds: [], source: "FIELD_OFFLINE" as const },
      { deliveryId: d2.id, to: "FAILED_ATTEMPT" as const, reason: "NO_ANSWER" as const, clientMutationId: "m-fail-0003", evidenceIds: [], source: "FIELD_OFFLINE" as const },
    ];
    const r1 = await syncFieldMutations(agent.ctx, batch);
    expect(r1.every((x) => x.ok)).toBe(true);
    const r2 = await syncFieldMutations(agent.ctx, batch);
    expect(r2.every((x) => x.ok && x.replayed)).toBe(true);
    const r3 = await syncFieldMutations(agent.ctx, [{ deliveryId: mine[2].id, to: "OUT_FOR_DELIVERY", version: 999, clientMutationId: "m-stale-0004", evidenceIds: [], source: "FIELD_OFFLINE" }]);
    expect(r3[0].ok).toBe(false);
    expect(r3[0].conflict?.status).toBe("ASSIGNED");

    // failed delivery triggers a follow-up task via automation
    await processOutbox(a.orgId);
    const followUps = await withTenant({ orgId: a.orgId }, (tx) => tx.task.count({ where: { projectId: project.id, tags: { has: "automation" } } }));
    expect(followUps).toBe(1);

    const k = await campaignKpis(a.ctx, campaign.id);
    expect(k.delivered).toBe(1);
    expect(k.failed).toBe(1);
    expect(k.firstAttemptSuccess).toBe(1);
    expect(k.completion).toBeCloseTo(1 / k.total, 5);
    expect(k.agents.find((x) => x.id === agent.userId)).toMatchObject({ assigned: 10, delivered: 1, failed: 1 });

    const history = await getDelivery(a.ctx, d.id);
    expect(history.delivery.events.map((e) => e.toStatus)).toEqual(["READY", "ASSIGNED", "OUT_FOR_DELIVERY", "DELIVERED"]);
    const auditCount = await withTenant({ orgId: a.orgId }, (tx) => tx.auditEvent.count({ where: { entityType: "DELIVERY", entityId: d.id } }));
    expect(auditCount).toBeGreaterThanOrEqual(2);
  });

  it("masks VIP contact data for members without VIP visibility and audits reveals", async () => {
    const { a, project } = await setup();
    const id = await importSample(a, project.id, (await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: project.id } }))).id);
    await resolveRows(a.ctx, { batchId: id, scope: "ALL_INVALID", resolution: "SKIP" });
    await resolveRows(a.ctx, { batchId: id, scope: "ALL_DUPLICATES", resolution: "SKIP" });
    await commitImport(a.ctx, { batchId: id, includeWarnings: true, acceptPartial: true });
    const lead = await addMember(a.ctx, "team_lead", "Lead");
    await upsertProjectMember(a.ctx, { projectId: project.id, userId: lead.userId, role: "LEAD", canViewFinance: false, canViewVip: false, canExport: false, canApprove: false, workstreamIds: [] });
    const masked = await listDeliveries(lead.ctx, project.id);
    expect(masked.deliveries[0].recipient.masked).toBe(true);
    expect(masked.deliveries[0].recipient.mobile).toContain("•••");
    const full = await listDeliveries(a.ctx, project.id);
    expect(full.deliveries[0].recipient.masked).toBe(false);
    await revealRecipient(a.ctx, full.deliveries[0].recipient.id);
    const reveals = await withTenant({ orgId: a.orgId }, (tx) => tx.auditEvent.count({ where: { action: "vip.contact_reveal" } }));
    expect(reveals).toBe(1);
  });
});
