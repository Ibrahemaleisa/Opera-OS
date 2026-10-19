import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/server/auth/crypto";
import { orgsWithPendingOutbox, processOutbox } from "@/server/modules/automation/engine";
import { schedulerTick } from "@/server/modules/automation/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Serverless stand-in for the worker's periodic sweeps (Vercel Cron): emits due-soon/overdue/
 * event-approaching events and drains any outbox rows a request didn't finish.
 * Vercel sends `Authorization: Bearer $CRON_SECRET`; without CRON_SECRET the route is disabled.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return new NextResponse("Not found", { status: 404 });
  const emitted = await schedulerTick();
  let processed = 0;
  for (const orgId of await orgsWithPendingOutbox()) processed += (await processOutbox(orgId, 500)).processed;
  return NextResponse.json({ ok: true, emitted, processed });
}
