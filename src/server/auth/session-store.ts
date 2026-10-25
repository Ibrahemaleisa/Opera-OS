import { db } from "@/server/db/client";
import { randomToken, sha256Hex } from "./crypto";

export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const RENEW_THRESHOLD_MS = 1000 * 60 * 60 * 24 * 15;
const TOUCH_INTERVAL_MS = 1000 * 60 * 5;

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

/** Creates a DB session. Only the SHA-256 of the token is stored; the raw token goes to the cookie. */
export async function createSession(userId: string, meta: SessionMeta = {}) {
  const token = randomToken(32);
  const id = sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: {
      id,
      userId,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip ?? null,
      deviceLabel: describeDevice(meta.userAgent),
    },
  });
  return { token, expiresAt };
}

export async function validateSessionToken(token: string) {
  if (!token || token.length > 200) return null;
  const id = sha256Hex(token);
  const session = await db.session.findUnique({
    where: { id },
    include: { user: { select: { id: true, email: true, name: true, nameAr: true, locale: true, calendar: true, theme: true, isPlatformAdmin: true, mfaEnabledAt: true } } },
  });
  if (!session || session.revokedAt) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await db.session.delete({ where: { id } }).catch(() => undefined);
    return null;
  }
  const renew = session.expiresAt.getTime() - now < RENEW_THRESHOLD_MS;
  if (renew || now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const data: { lastSeenAt: Date; expiresAt?: Date } = { lastSeenAt: new Date() };
    if (renew) data.expiresAt = new Date(now + SESSION_TTL_MS);
    await db.session.update({ where: { id }, data }).catch(() => undefined);
    if (data.expiresAt) session.expiresAt = data.expiresAt;
  }
  return session;
}

export async function revokeSession(token: string) {
  await db.session.updateMany({ where: { id: sha256Hex(token) }, data: { revokedAt: new Date() } });
}

export async function revokeSessionById(id: string, userId: string) {
  await db.session.updateMany({ where: { id, userId }, data: { revokedAt: new Date() } });
}

/** Called on role change / revocation / password change. */
export async function revokeAllSessions(userId: string, exceptId?: string) {
  await db.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

function describeDevice(ua?: string | null): string | null {
  if (!ua) return null;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return `${browser} · ${os}`;
}
