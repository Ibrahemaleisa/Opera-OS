import ExcelJS from "exceljs";
import type { NextRequest } from "next/server";
import { formatDateTime } from "@/lib/format";
import { getMessages } from "@/lib/i18n";
import { maskPhone } from "@/lib/phone";
import { addXlsxRow } from "@/server/modules/delivery/export";
import { guestListRows } from "@/server/modules/digital/service";
import { requireActionContext } from "@/server/request";
import { fileResponse, jsonError } from "@/server/route";

export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string }> }) {
  try {
    const { org } = await params;
    const ctx = await requireActionContext(org);
    const { campaign, rows, vip } = await guestListRows(ctx, req.nextUrl.searchParams.get("campaignId") ?? "");
    const m = getMessages(ctx.locale);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Guests", { views: [{ rightToLeft: ctx.locale === "ar" }] });
    ws.addRow([m.delivery.registry.code, m.common.name, m.common.nameEn, m.projects.client, m.delivery.registry.tier, m.digital.channel, m.common.phone, m.common.status, m.digital.rsvp, m.digital.public.guests, m.digital.checkedIn]).font = { bold: true };
    for (const { inv, r } of rows) {
      // KD-4: string cells; an E.164 number in the contact column is written without an apostrophe
      addXlsxRow(ws, [r.code, r.nameAr, r.nameEn, r.organizationName, r.vipTier, inv.channel, vip ? inv.address : inv.address.includes("@") ? "•••" : maskPhone(inv.address), m.enums.messageStatus[inv.status], inv.rsvpStatus ? m.enums.rsvp[inv.rsvpStatus] : "", inv.rsvps[0]?.guestsCount ?? "", inv.checkedInAt ? formatDateTime(inv.checkedInAt, { locale: ctx.locale }) : ""], new Set([6]));
    }
    ws.columns.forEach((c) => (c.width = 20));
    return fileResponse(Buffer.from(await wb.xlsx.writeBuffer()), `guest-list-${campaign.name.replace(/[^\p{L}\p{N}]+/gu, "-")}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  } catch (e) {
    return jsonError(e);
  }
}
