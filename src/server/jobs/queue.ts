import { Queue, type JobsOptions } from "bullmq";
import { getRedis } from "@/server/redis";

export const QUEUE_NAME = "operra";

export type JobName = "outbox" | "import.validate" | "import.commit" | "message.send" | "campaign.dispatch" | "scheduler.tick";

export interface JobPayloads {
  outbox: { orgId: string };
  "import.validate": { orgId: string; actorId: string; batchId: string };
  "import.commit": { orgId: string; actorId: string; batchId: string };
  "message.send": { orgId: string; messageJobId: string };
  "campaign.dispatch": { orgId: string; actorId: string; campaignId: string };
  "scheduler.tick": Record<string, never>;
}

let queue: Queue | null | undefined;

export function getQueue(): Queue | null {
  if (queue !== undefined) return queue;
  const redis = getRedis();
  if (!redis) return (queue = null);
  queue = new Queue(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 500, removeOnFail: 2000 },
  });
  return queue;
}

export function jobsMode(): "queue" | "inline" {
  return process.env.JOBS_MODE === "inline" ? "inline" : "queue";
}
