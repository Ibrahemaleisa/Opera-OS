/**
 * QA audit (Agent 5) — Excel Import Studio with hostile real-world files, and what the
 * resulting data looks like in exports.
 */
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { exportDeliveries } from "@/server/modules/delivery/export";
import { commitImport, configureAndValidate, createImport, getImportPreview, importReport, listImportRows, resolveRows } from "@/server/modules/delivery/imports/service";
import { upsertProjectMember } from "@/server/modules/projects/service";
import { addMember, createAgency } from "../../helpers";
import { blankProject, templateId, type Agency } from "./qa-helpers";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PHONE = /(\+?966|\b0)5\d{8}\b/;

async function deliveryProject(name: string) {
  const a = await createAgency(name);
  const p = await blankProject(a.ctx, name, { templateIds: [await templateId(a, "vip-physical-delivery")], eventStartAt: new Date(Date.now() + 20 * 86_400_000) });
  const campaign = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "PHYSICAL" } }));
  return { a, p, campaign };
}

async function upload(a: Agency, projectId: string, campaignId: string | null, fileName: string, body: Buffer) {
  const batch = await createImport(a.ctx, { projectId, campaignId, fileName, declaredType: XLSX, body });
  const preview = await getImportPreview(a.ctx, batch.id);
  return { batch, preview };
}

async function validate(a: Agency, batchId: string, preview: Awaited<ReturnType<typeof getImportPreview>>) {
  await configureAndValidate(a.ctx, { batchId, sheetName: preview.sheetName, headerRow: preview.headerRow, mapping: preview.mapping as Record<string, string>, options: { duplicateScope: "PROJECT", matchOn: ["mobile", "externalRef", "name"], requireMobile: true, requireLocation: true } });
  return listImportRows(a.ctx, batchId, { take: 1000 });
}

async function book(build: (wb: ExcelJS.Workbook) => void) {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("QA: import studio with hostile files", () => {
  async function nastyBatch(name: string) {
    const { a, p, campaign } = await deliveryProject(name);
    const body = await book((wb) => {
      const notes = wb.addWorksheet("تعليمات"); // decoy sheet first, with prose
      notes.addRow(["يرجى عدم تعديل هذا الملف"]);
      notes.addRow(["آخر تحديث: الأحد"]);
      notes.addRow(["المسؤول: إدارة المراسم"]);
      const ws = wb.addWorksheet("المدعوين");
      ws.addRow(["قائمة كبار الضيوف — سري"]);
      ws.mergeCells("A1:F1");
      ws.addRow(["الاسم", "رقم الجوال", "العنوان", "المدينة", "الجهة", "ملاحظات"]);
      ws.addRow(["سعادة أحمد", "0551234567", "حي النخيل", "الرياض", "وزارة", ""]);
      ws.addRow(["سعادة أحمد", "+966551234567", "حي النخيل", "الرياض", "وزارة", "duplicate by mobile"]);
      ws.addRow([null, null, null, null, null, null]); // empty row
      ws.addRow(["ضيف برقم خاطئ", "12345", "حي الملقا", "الرياض", "", ""]);
      ws.addRow(["=HYPERLINK(\"http://evil.example\",\"اضغط\")", "0559876543", "حي الورود", "جدة", "", "text formula"]);
      ws.addRow([{ formula: "1+1", result: 2 } as unknown as string, "0558887777", "حي العليا", "الرياض", "", "real formula cell"]);
      ws.addRow(["ضيف بلا عنوان", "0557778888", "", "", "", ""]);
      ws.addRow(["ضيف بأرقام عربية", "٠٥٥٦٦٦٧٧٧٧", "حي السفارات", "الرياض", "", "arabic digits"]);
    });
    const { batch, preview } = await upload(a, p.id, campaign.id, "nasty.xlsx", body);
    const sheet = batch.sheetNames.find((s) => s === "المدعوين")!;
    const real = await getImportPreview(a.ctx, batch.id, { sheetName: sheet, headerRow: 2 });
    const rows = await validate(a, batch.id, { ...real, sheetName: sheet, headerRow: 2, mapping: { ...real.mapping, nameAr: "الاسم", mobile: "رقم الجوال", address: "العنوان", city: "المدينة" } });
    return { firstPick: preview.sheetName, by: (n: number) => rows.rows.find((r) => r.rowNumber === n) };
  }

  it("hostile file: duplicates, invalid phones, empty rows, formula cells and Arabic digits are classified correctly (regression)", async () => {
    const { by } = await nastyBatch("QA NastyImport");
    expect(by(4)?.status).toBe("DUPLICATE"); // same mobile in two notations
    expect(by(5)).toBeUndefined(); // empty row ignored
    expect(by(6)?.status).toBe("INVALID"); // invalid phone
    expect(JSON.stringify(by(8)?.normalized ?? {})).not.toContain("1+1"); // formula cell → cached result only, never the formula
    expect(by(9)?.status).toBe("INVALID"); // no location while required
    expect((by(10)?.normalized as { mobile?: string })?.mobile).toBe("+966556667777"); // Arabic digits normalised
  });

  // QA S4-3, fixed in Milestone 2 (BUSINESS_RULES KD-2: the sheet with the best header score is picked).
  it("[S4-3] KD-2 a decoy instructions sheet placed first is not auto-selected", async () => {
    const { firstPick } = await nastyBatch("QA NastyDecoy");
    expect(firstPick, "decoy sheet auto-selected (UX risk)").toBe("المدعوين");
  });

  // QA S4-4, fixed in Milestone 2 (BUSINESS_RULES KD-3: formula-looking text gets an import.formulaLike warning).
  it("[S4-4] KD-3 a formula-looking name gets a warning", async () => {
    const { by } = await nastyBatch("QA NastyFormula");
    expect((by(7)?.warnings as unknown[] | undefined)?.length ?? 0, "formula-looking name gets a warning").toBeGreaterThan(0);
  });

  async function injectionExports(name: string) {
    const { a, p, campaign } = await deliveryProject(name);
    const body = await book((wb) => {
      const ws = wb.addWorksheet("List");
      ws.addRow(["الاسم", "رقم الجوال", "العنوان", "المدينة"]);
      ws.addRow(["=cmd|' /C calc'!A0", "0551112222", "حي الياسمين", "الرياض"]);
      ws.addRow(["@SUM(1+1)*cmd", "0551113333", "حي الياسمين", "الرياض"]);
    });
    const { batch, preview } = await upload(a, p.id, campaign.id, "inject.xlsx", body);
    await validate(a, batch.id, preview);
    await commitImport(a.ctx, { batchId: batch.id, includeWarnings: true, acceptPartial: true });
    const csv = (await exportDeliveries(a.ctx, { projectId: p.id, format: "csv" })).body as string;
    const xbuf = (await exportDeliveries(a.ctx, { projectId: p.id, format: "xlsx" })).body as Buffer;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xbuf as unknown as ArrayBuffer);
    const cells: string[] = [];
    wb.worksheets[0].eachRow((r) => r.eachCell((c) => cells.push(String(c.value))));
    return { csv, cells };
  }

  it("exports neutralise formula injection from imported names (regression)", async () => {
    const { csv, cells } = await injectionExports("QA ExportInjection");
    expect(csv).toContain("'=cmd|");
    expect(csv).toContain("'@SUM");
    expect(cells.some((c) => c.startsWith("="))).toBe(false);
  });

  // QA S4-2, fixed in Milestone 2 (BUSINESS_RULES KD-4: XLSX string cells, E.164 phones unprefixed).
  it("[S4-2] KD-4 XLSX exports keep phone numbers without a literal apostrophe", async () => {
    const { cells } = await injectionExports("QA ExportPhones");
    expect(cells.filter((c) => /^'\+9665/.test(c)), "phones exported as \"'+9665…\" text").toHaveLength(0);
  });

  it("a project member without VIP visibility does not see unmasked phone numbers in import review or the error report", async () => {
    const { a, p, campaign } = await deliveryProject("QA ImportMasking");
    const pm2 = await addMember(a.ctx, "project_manager", "Second PM (no VIP)");
    await upsertProjectMember(a.ctx, { projectId: p.id, userId: pm2.userId, role: "MEMBER", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    const { batch, preview } = await upload(a, p.id, campaign.id, "vip-recipients-ar.xlsx", readFileSync("samples/vip-recipients-ar.xlsx"));
    await validate(a, batch.id, preview);
    const asPm2 = await listImportRows(pm2.ctx, batch.id, { take: 1000 });
    expect(asPm2.vip).toBe(false); // the service knows the caller lacks VIP scope …
    const leaked = asPm2.rows.filter((r) => PHONE.test(JSON.stringify(r.normalized)) || PHONE.test(JSON.stringify(r.raw)));
    expect.soft(leaked.length, "rows returned with full phone numbers").toBe(0); // … EXPECTED: and masks them
    const report = await importReport(pm2.ctx, batch.id, "errors", (c) => c);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(report.buffer as unknown as ArrayBuffer);
    const cells: string[] = [];
    wb.worksheets[0].eachRow((r) => r.eachCell((c) => cells.push(String(c.value))));
    expect.soft(cells.filter((c) => PHONE.test(c)).length, "error report cells with full phone numbers").toBe(0);
  });

  it("double-clicked Commit imports each row once (control)", async () => {
    const { a, p, campaign } = await deliveryProject("QA DoubleCommit");
    const { batch, preview } = await upload(a, p.id, campaign.id, "vip-recipients-ar.xlsx", readFileSync("samples/vip-recipients-ar.xlsx"));
    await validate(a, batch.id, preview);
    await resolveRows(a.ctx, { batchId: batch.id, scope: "ALL_DUPLICATES", resolution: "SKIP" });
    const r = await Promise.allSettled([
      commitImport(a.ctx, { batchId: batch.id, includeWarnings: true, acceptPartial: true }),
      commitImport(a.ctx, { batchId: batch.id, includeWarnings: true, acceptPartial: true }),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const { recipients, committed } = await withTenant({ orgId: a.orgId }, async (tx) => ({
      recipients: await tx.recipient.count({ where: { projectId: p.id } }),
      committed: (await tx.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).committedRows,
    }));
    expect(recipients).toBe(committed);
  });

  it("very large files: 20,001 rows are refused; 5,000 rows complete in-request", async () => {
    const { a, p, campaign } = await deliveryProject("QA LargeImport");
    const make = (n: number) => book((wb) => {
      const ws = wb.addWorksheet("List");
      ws.addRow(["الاسم", "رقم الجوال", "العنوان", "المدينة"]);
      for (let i = 0; i < n; i++) ws.addRow([`ضيف ${i}`, `055${String(1_000_000 + i).slice(-7)}`, `حي ${i % 50}`, "الرياض"]);
    });
    const tooBig = await make(20_001);
    // M2 (BUSINESS_RULES §7.1 rule 4, SW-7): the cap is IMPORT_MAX_ROWS (default 10,000), checked before parsing
    await expect(createImport(a.ctx, { projectId: p.id, campaignId: campaign.id, fileName: "big.xlsx", declaredType: XLSX, body: tooBig })).rejects.toThrow("errors.tooManyRows");
    const t0 = Date.now();
    const { batch, preview } = await upload(a, p.id, campaign.id, "5k.xlsx", await make(5_000));
    const rows = await validate(a, batch.id, preview);
    expect(rows.batch.totalRows).toBe(5_000);
    await commitImport(a.ctx, { batchId: batch.id, includeWarnings: true, acceptPartial: true });
    const seconds = (Date.now() - t0) / 1000;
    console.log(`[qa] 5,000-row import upload→validate→commit took ${seconds.toFixed(1)}s in one process`);
    const n = await withTenant({ orgId: a.orgId }, (tx) => tx.delivery.count({ where: { projectId: p.id } }));
    expect(n).toBe(5_000);
  }, 240_000);
});
