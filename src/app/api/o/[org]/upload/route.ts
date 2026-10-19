import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin } from "@/server/http";
import { AppError } from "@/server/errors";
import { requireActionContext } from "@/server/request";
import { uploadForEntity } from "@/server/modules/files/upload";

/** Multipart upload for attachments/evidence. Authorization is per target entity. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ org: string }> }) {
  try {
    assertSameOrigin(req);
    const { org } = await params;
    const ctx = await requireActionContext(org);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "errors.fileType" }, { status: 422 });
    const att = await uploadForEntity(ctx, {
      entityType: String(form.get("entityType") ?? ""),
      entityId: String(form.get("entityId") ?? ""),
      kind: form.get("kind") ? String(form.get("kind")) : undefined,
      clientVisible: form.get("clientVisible") === "true",
      previousId: form.get("previousId") ? String(form.get("previousId")) : null,
      fileName: file.name,
      declaredType: file.type,
      body: Buffer.from(await file.arrayBuffer()),
    });
    return NextResponse.json({ ok: true, data: { id: att.id, fileName: att.fileName, version: att.version } });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: e.status });
    console.error(e);
    return NextResponse.json({ ok: false, error: "errors.unexpected" }, { status: 500 });
  }
}
