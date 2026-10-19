import type { NextRequest } from "next/server";
import { getMessages, translateKey } from "@/lib/i18n";
import { importReport } from "@/server/modules/delivery/imports/service";
import { requireActionContext } from "@/server/request";
import { fileResponse, jsonError } from "@/server/route";

export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string; batchId: string }> }) {
  try {
    const { org, batchId } = await params;
    const ctx = await requireActionContext(org);
    const kind = (req.nextUrl.searchParams.get("kind") ?? "errors") as "errors" | "normalized" | "original";
    const m = getMessages(ctx.locale);
    const r = await importReport(ctx, batchId, ["errors", "normalized", "original"].includes(kind) ? kind : "errors", (code) => translateKey(m, `importErrors.${code}`));
    return fileResponse(r.buffer, r.fileName, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  } catch (e) {
    return jsonError(e);
  }
}
