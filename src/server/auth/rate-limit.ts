import { getRedis } from "@/server/redis";
import { RateLimitError } from "@/server/errors";

const memory = new Map<string, { count: number; resetAt: number }>();

/** Fixed-window limiter. Redis-backed when available, in-memory fallback (single instance). */
export async function rateLimit(key: string, baseLimit: number, windowSec: number): Promise<{ ok: boolean; remaining: number }> {
  // RATE_LIMIT_MULTIPLIER relaxes limits for local development / E2E runs only (never set in production).
  const multiplier = process.env.NODE_ENV === "production" ? 1 : Math.max(1, Number(process.env.RATE_LIMIT_MULTIPLIER ?? 1));
  const limit = baseLimit * multiplier;
  const redis = getRedis();
  if (redis && redis.status === "ready") {
    try {
      const k = `rl:${key}`;
      const count = await redis.incr(k);
      if (count === 1) await redis.expire(k, windowSec);
      return { ok: count <= limit, remaining: Math.max(0, limit - count) };
    } catch {
      /* fall through */
    }
  }
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { ok: true, remaining: limit - 1 };
  }
  entry.count += 1;
  return { ok: entry.count <= limit, remaining: Math.max(0, limit - entry.count) };
}

export async function enforceRateLimit(key: string, limit: number, windowSec: number) {
  const r = await rateLimit(key, limit, windowSec);
  if (!r.ok) throw new RateLimitError();
}
