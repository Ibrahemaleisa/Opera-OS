import { NextResponse } from "next/server";
import { myFieldDeliveries } from "@/server/modules/delivery/service";
import { requireActionContext } from "@/server/request";
import { jsonError } from "@/server/route";

export async function GET(_req: Request, { params }: { params: Promise<{ org: string }> }) {
  try {
    const { org } = await params;
    const ctx = await requireActionContext(org);
    return NextResponse.json({ ok: true, data: await myFieldDeliveries(ctx) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return jsonError(e);
  }
}
