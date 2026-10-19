import type { NextRequest } from "next/server";
import { exportDeliveries } from "@/server/modules/delivery/export";
import { requireActionContext } from "@/server/request";
import { fileResponse, jsonError } from "@/server/route";

export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string }> }) {
  try {
    const { org } = await params;
    const ctx = await requireActionContext(org);
    const sp = req.nextUrl.searchParams;
    const r = await exportDeliveries(ctx, { projectId: sp.get("projectId") ?? "", campaignId: sp.get("campaignId") ?? undefined, format: sp.get("format") === "csv" ? "csv" : "xlsx" });
    return fileResponse(r.body, r.fileName, r.contentType);
  } catch (e) {
    return jsonError(e);
  }
}
