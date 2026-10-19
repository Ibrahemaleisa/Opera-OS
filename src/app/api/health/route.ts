import { NextResponse } from "next/server";
import { db } from "@/server/db/client";
import { getRedis } from "@/server/redis";

export const dynamic = "force-dynamic";

/** Liveness/readiness probe for containers: database required, Redis reported (jobs fall back to inline). */
export async function GET() {
  const checks: Record<string, "ok" | "down"> = {};
  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "down";
  }
  try {
    const r = getRedis();
    checks.redis = r && (await Promise.race([r.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1000))])) === "PONG" ? "ok" : "down";
  } catch {
    checks.redis = "down";
  }
  const ok = checks.database === "ok";
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
