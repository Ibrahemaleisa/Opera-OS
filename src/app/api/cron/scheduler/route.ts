import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/server/auth/crypto";
import { orgsWithPendingOutbox, processOutbox } from "@/server/modules/automation/engine";
import { schedulerTick } from "@/server/modules/automation/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Serverless stand-in for the worker's periodic sweeps. Production MUST call it at least every
 * 5 minutes (BUSINESS_RULES §0, §7.4): reminders, the escalation ladders, stalled-work recovery,
 * scheduled sends and e-mail retries all run from here. A daily cron does not meet the escalation
 * timers, and System health shows the gap.
 *
 * Safe to call as often as you like: every reminder and escalation tier fires once per occurrence, an
 * overlapping call skips organisations another tick is working on, and each step is bounded (a backlog
 * drains over several calls). Callers send `Authorization: Bearer $CRON_SECRET` (Vercel Cron does);
 * without CRON_SECRET the route is disabled.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return new NextResponse("Not found", { status: 404 });
  const tick = await schedulerTick();
  let processed = 0;
  for (const orgId of await orgsWithPendingOutbox()) processed += (await processOutbox(orgId, 500)).processed;
  return NextResponse.json({ ok: true, orgs: tick.orgs, emitted: tick.emitted, notices: tick.notices, processed });
}
