import { db } from "@/server/db/client";

/** Account lockout (M1): 8 consecutive failures (passwords and MFA codes alike) lock sign-in for 15 minutes. */
export const LOCK_AFTER = 8;
export const LOCK_MINUTES = 15;

/** Counts one failure; returns true when this failure locked the account. */
export async function recordFailedLogin(userId: string, now = new Date()): Promise<boolean> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { failedLogins: true } });
  if (!u) return false;
  const failed = u.failedLogins + 1;
  const lock = failed >= LOCK_AFTER;
  await db.user.update({ where: { id: userId }, data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null } });
  return lock;
}
