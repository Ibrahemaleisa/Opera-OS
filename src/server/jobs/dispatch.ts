import { getQueue, jobsMode, type JobName, type JobPayloads } from "./queue";
import type { JobsOptions } from "bullmq";
import { after } from "next/server";

/**
 * Enqueue a job, or run it in-process when JOBS_MODE=inline or Redis is unavailable.
 * Handlers are idempotent, so a fallback inline run is always safe.
 * Returns "queued" or "inline" so callers can report honestly.
 */
export async function enqueue<N extends JobName>(name: N, data: JobPayloads[N], opts: JobsOptions = {}): Promise<"queued" | "inline"> {
  if (jobsMode() === "queue") {
    const q = getQueue();
    if (q) {
      try {
        await q.add(name, data, opts);
        return "queued";
      } catch (err) {
        console.warn(`[jobs] enqueue ${name} failed, running inline`, (err as Error).message);
      }
    }
  }
  const { runJob } = await import("./handlers");
  await runJob(name, data);
  return "inline";
}

/** Nudge the automation dispatcher after a mutation. Never throws. */
export async function kickOutbox(orgId: string) {
  try {
    if (jobsMode() === "inline") {
      const { processOutbox } = await import("@/server/modules/automation/engine");
      await processOutbox(orgId);
      // no worker in inline mode: requests also release scheduled campaigns that have become due
      const { dispatchDueCampaigns } = await import("@/server/modules/digital/sender");
      await dispatchDueCampaigns(orgId);
      // e-mail written by this request's notices goes out after commit (§3.1 rule 2)
      const { sendDueDeliveries } = await import("@/server/modules/notifications/delivery");
      await sendDueDeliveries(orgId, { limit: 50 });
      return;
    }
    const bucket = Math.floor(Date.now() / 1000);
    await enqueue("outbox", { orgId }, { jobId: `outbox-${orgId}-${bucket}`, attempts: 1 });
  } catch (err) {
    console.warn("[jobs] kickOutbox failed (worker sweep will retry)", (err as Error).message);
  }
}

/**
 * Runs kickOutbox after the response is sent, inside the request's lifetime (`after` → waitUntil on
 * serverless), so the work isn't frozen with the function. Outside a request scope (scripts, worker,
 * tests) it simply runs detached.
 */
export function kickOutboxAfterResponse(orgId: string) {
  try {
    after(() => kickOutbox(orgId));
  } catch {
    void kickOutbox(orgId);
  }
}
