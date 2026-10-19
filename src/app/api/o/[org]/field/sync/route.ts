import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/http";
import { statusSchema, syncFieldMutations } from "@/server/modules/delivery/service";
import { requireActionContext } from "@/server/request";
import { jsonError } from "@/server/route";
import { kickOutbox } from "@/server/jobs/dispatch";
import { ValidationError } from "@/server/errors";

const body = z.object({ mutations: z.array(statusSchema).max(100) });

/** Offline queue replay endpoint for the field PWA. Each mutation is idempotent (clientMutationId). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ org: string }> }) {
  try {
    assertSameOrigin(req);
    const { org } = await params;
    const ctx = await requireActionContext(org);
    const parsed = body.safeParse(await req.json());
    if (!parsed.success) throw new ValidationError();
    const results = await syncFieldMutations(ctx, parsed.data.mutations);
    void kickOutbox(ctx.orgId);
    return NextResponse.json({ ok: true, data: results });
  } catch (e) {
    return jsonError(e);
  }
}
