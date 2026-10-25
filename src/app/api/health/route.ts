import { NextResponse } from "next/server";
import { db } from "@/server/db/client";
import { getRedis } from "@/server/redis";
import { healthCounts } from "@/server/modules/recovery/service";

export const dynamic = "force-dynamic";

/**
 * Liveness/readiness probe for containers: database required, Redis reported (jobs fall back to inline).
 * `work` carries platform-wide counts of stalled or dead background work (BUSINESS_RULES §7.4) — totals
 * only, never an organisation, id, name or error text.
 */
export async function GET() {
  const checks: Record<string, "ok" | "down"> = {};
  let dbRoundTripMs: number | null = null;
  try {
    await db.$queryRaw`SELECT 1`;
    // median of a few round trips: the main latency driver for server-rendered pages
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await db.$queryRaw`SELECT 1`;
      samples.push(performance.now() - t);
    }
    dbRoundTripMs = Math.round(samples.sort((a, b) => a - b)[2] * 10) / 10;
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
  let work: Awaited<ReturnType<typeof healthCounts>> | null = null;
  if (ok) work = await healthCounts().catch(() => null);
  return NextResponse.json({ ok, checks, dbRoundTripMs, region: process.env.VERCEL_REGION ?? null, work }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
