import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin } from "@/server/http";
import { maxUploadBytes } from "@/server/modules/files/storage";
import { createImport } from "@/server/modules/delivery/imports/service";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { ValidationError } from "@/server/errors";
import { requireActionContext } from "@/server/request";
import { jsonError } from "@/server/route";

export async function POST(req: NextRequest, { params }: { params: Promise<{ org: string }> }) {
  try {
    assertSameOrigin(req);
    const { org } = await params;
    const ctx = await requireActionContext(org);
    await enforceRateLimit(`import:${ctx.userId}`, 30, 3600);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ValidationError("errors.fileType");
    if (file.size > maxUploadBytes()) throw new ValidationError("errors.fileTooLarge");
    const batch = await createImport(ctx, {
      projectId: String(form.get("projectId") ?? ""),
      campaignId: form.get("campaignId") ? String(form.get("campaignId")) : null,
      fileName: file.name,
      declaredType: file.type,
      body: Buffer.from(await file.arrayBuffer()),
    });
    return NextResponse.json({ ok: true, data: { batchId: batch.id } });
  } catch (e) {
    return jsonError(e);
  }
}
