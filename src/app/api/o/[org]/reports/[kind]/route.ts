import type { NextRequest } from "next/server";
import { toCsv } from "@/lib/csv";
import { NotFoundError } from "@/server/errors";
import { buildReport, REPORT_KINDS, type ReportKind } from "@/server/modules/reports/service";
import { requireActionContext } from "@/server/request";
import { fileResponse, jsonError } from "@/server/route";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ org: string; kind: string }> }) {
  try {
    const { org, kind } = await params;
    if (!(REPORT_KINDS as readonly string[]).includes(kind)) throw new NotFoundError();
    const ctx = await requireActionContext(org);
    const { headers, rows } = await buildReport(ctx, kind as ReportKind);
    const stamp = new Date().toISOString().slice(0, 10);
    return fileResponse(Buffer.from(toCsv(headers, rows), "utf8"), `${kind}-${stamp}.csv`, "text/csv; charset=utf-8");
  } catch (e) {
    return jsonError(e);
  }
}
