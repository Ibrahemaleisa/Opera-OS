import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { storage, verifyLocalSignature } from "@/server/modules/files/storage";
import { getSession } from "@/server/request";

/**
 * Serves a file for the local storage driver. Requires BOTH a valid HMAC signature
 * (issued only after an authorization check) AND an authenticated session.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  if (!verifyLocalSignature(id, sp.get("exp"), sp.get("sig"))) return new NextResponse("Not found", { status: 404 });
  const session = await getSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  const orgIds = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.user_id', ${session.userId}, true)`;
    return (await tx.membership.findMany({ where: { userId: session.userId, status: "ACTIVE" }, select: { organizationId: true } })).map((m) => m.organizationId);
  });
  for (const orgId of orgIds) {
    const att = await withTenant({ orgId, userId: session.userId }, (tx) => tx.attachment.findUnique({ where: { id } }));
    if (!att) continue;
    const body = await storage().get(att.storageKey);
    const inline = att.mimeType.startsWith("image/") && att.mimeType !== "image/svg+xml" || att.mimeType === "application/pdf";
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": att.mimeType,
        "Content-Length": String(body.length),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att.fileName)}`,
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return new NextResponse("Not found", { status: 404 });
}
