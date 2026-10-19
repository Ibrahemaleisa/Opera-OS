import ExcelJS from "exceljs";
import { neutralizeFormula, toCsv } from "@/lib/csv";
import { formatDateTime } from "@/lib/format";
import { getMessages } from "@/lib/i18n";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan, projectScope } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";
import { ForbiddenError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { listDeliveries } from "./service";
import { campaignKpis } from "./analytics";

/**
 * Delivery report export. Requires export permission (org + project). Contact data is only
 * included unmasked for callers with VIP visibility; every export is audited.
 */
export async function exportDeliveries(ctx: ServiceContext, input: { projectId: string; campaignId?: string; format: "csv" | "xlsx" }) {
  assertCan(ctx, "export.data");
  const scope = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => projectScope(tx, ctx, input.projectId));
  if (!scope.export) throw new ForbiddenError();
  const { deliveries } = await listDeliveries(ctx, input.projectId, { campaignId: input.campaignId });
  const m = getMessages(ctx.locale);
  const fmt = { locale: ctx.locale };
  const headers = [m.delivery.trackingCode, m.delivery.registry.code, m.common.name, m.common.nameEn, m.org.jobTitle, m.projects.client, m.delivery.registry.tier, m.common.phone, m.common.city, m.common.district, m.common.address, m.common.status, m.delivery.agent, m.delivery.batch, m.delivery.attempts, m.delivery.delivered, m.delivery.failureReason, m.common.priority];
  const rows = deliveries.map((d) => [
    d.trackingCode, d.recipient.code, d.recipient.nameAr, d.recipient.nameEn, d.recipient.jobTitle, d.recipient.organizationName, d.recipient.vipTier, d.recipient.mobile, d.recipient.city, d.recipient.district, d.recipient.address,
    m.enums.deliveryStatus[d.status], d.agent?.name ?? "", d.batch?.code ?? "", d.attemptsCount, d.deliveredAt ? formatDateTime(d.deliveredAt, fmt) : "", d.failureReason ? (m.delivery.reasons as Record<string, string>)[d.failureReason] ?? d.failureReason : "", m.enums.priority[d.priority],
  ]);
  await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => audit(tx, ctx, { action: "export.deliveries", entityType: "DELIVERY", projectId: input.projectId, summary: `${rows.length} rows (${input.format})`, meta: { campaignId: input.campaignId, masked: !scope.vip } }));
  const stamp = new Date().toISOString().slice(0, 10);
  if (input.format === "csv") return { body: toCsv(headers, rows), fileName: `deliveries-${stamp}.csv`, contentType: "text/csv; charset=utf-8" };
  const wb = new ExcelJS.Workbook();
  wb.creator = "Operra";
  const ws = wb.addWorksheet(m.delivery.cards, { views: [{ rightToLeft: ctx.locale === "ar", state: "frozen", ySplit: 1 }] });
  ws.addRow(headers).font = { bold: true };
  for (const r of rows) ws.addRow(r.map((v) => (typeof v === "number" ? v : neutralizeFormula(v))));
  ws.columns.forEach((c) => (c.width = 18));
  if (input.campaignId) {
    const k = await campaignKpis(ctx, input.campaignId);
    const s = wb.addWorksheet("KPIs", { views: [{ rightToLeft: ctx.locale === "ar" }] });
    const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 1000) / 10}%`);
    [[m.common.total, k.total], [m.delivery.delivered, k.delivered], [m.delivery.failed, k.failed], [m.enums.deliveryStatus.RESCHEDULED, k.rescheduled], [m.delivery.completion, pct(k.completion)], [m.delivery.firstAttempt, pct(k.firstAttemptSuccess)], [m.delivery.sla, pct(k.slaCompliance)]].forEach((r) => s.addRow(r));
    s.addRow([]);
    s.addRow([m.delivery.agent, m.delivery.registry.deliveries, m.delivery.delivered, m.delivery.failed]).font = { bold: true };
    k.agents.forEach((a) => s.addRow([neutralizeFormula(a.name), a.assigned, a.delivered, a.failed]));
    s.columns.forEach((c) => (c.width = 24));
  }
  return { body: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `deliveries-${stamp}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}
