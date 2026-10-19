import IORedis, { type Redis } from "ioredis";

let client: Redis | null | undefined;

/** Shared Redis connection, or null when REDIS_URL is not configured / unreachable. */
export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.REDIS_URL;
  if (!url) return (client = null);
  client = new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: false, enableOfflineQueue: false });
  client.on("error", () => {
    /* surfaced via health check; callers fall back */
  });
  return client;
}
