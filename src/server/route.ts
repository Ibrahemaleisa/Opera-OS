import { NextResponse } from "next/server";
import { AppError } from "@/server/errors";

export function jsonError(e: unknown) {
  if (e instanceof AppError) return NextResponse.json({ ok: false, error: e.message, code: e.code, fieldErrors: e.fieldErrors }, { status: e.status });
  console.error("[route]", e);
  return NextResponse.json({ ok: false, error: "errors.unexpected" }, { status: 500 });
}

export function fileResponse(body: Buffer | string, fileName: string, contentType: string) {
  return new NextResponse(typeof body === "string" ? body : new Uint8Array(body), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
