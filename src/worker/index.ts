/**
 * Background worker: consumes the BullMQ queue and runs periodic sweeps.
 *  - outbox sweep every 10s (safety net if a kick was lost)
 *  - scheduler tick every 5 min (due-soon, overdue, event-approaching)
 * Run with: pnpm worker
 */
import "dotenv/config";
import { Worker } from "bullmq";
import { getQueue, QUEUE_NAME, type JobName } from "@/server/jobs/queue";
import { runJob } from "@/server/jobs/handlers";
import { getRedis } from "@/server/redis";
import { orgsWithPendingOutbox, processOutbox } from "@/server/modules/automation/engine";

async function main() {
  const connection = getRedis();
  if (!connection) throw new Error("REDIS_URL is required for the worker (or use JOBS_MODE=inline)");
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const started = Date.now();
      const result = await runJob(job.name as JobName, job.data);
      console.log(`[worker] ${job.name} ${job.id} done in ${Date.now() - started}ms`);
      return result ?? null;
    },
    { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) },
  );
  worker.on("failed", (job, err) => console.error(`[worker] ${job?.name} ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message));

  const queue = getQueue()!;
  await queue.upsertJobScheduler("scheduler-tick", { every: 5 * 60_000 }, { name: "scheduler.tick", data: {} });

  const sweep = async () => {
    try {
      for (const orgId of await orgsWithPendingOutbox()) await processOutbox(orgId);
    } catch (e) {
      console.error("[worker] outbox sweep failed", (e as Error).message);
    }
  };
  const interval = setInterval(sweep, 10_000);
  await sweep();
  console.log(`[worker] listening on queue "${QUEUE_NAME}"`);

  const shutdown = async () => {
    clearInterval(interval);
    await worker.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
