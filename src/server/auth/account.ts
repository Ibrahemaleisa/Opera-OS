import { z } from "zod";
import { db } from "@/server/db/client";
import { withUser } from "@/server/db/tenant";
import { ValidationError } from "@/server/errors";
import { hashPassword, passwordProblems, verifyPassword } from "./password";
import { enforceRateLimit } from "./rate-limit";
import { revokeAllSessions } from "./session-store";

export const profileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  nameAr: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(30).nullish(),
  locale: z.enum(["ar", "en"]),
  calendar: z.enum(["gregory", "islamic-umalqura"]),
});

export const passwordSchema = z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) });

export async function getAccount(userId: string) {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, name: true, nameAr: true, phone: true, locale: true, calendar: true, lastLoginAt: true } });
  // memberships/roles/orgs are tenant tables: read them under the user's own RLS scope
  const memberships = await withUser(userId, async (tx) => {
    const rows = await tx.membership.findMany({ where: { userId, status: "ACTIVE" }, include: { role: { select: { nameAr: true, nameEn: true } } } });
    const orgs = await tx.organization.findMany({ where: { id: { in: rows.map((r) => r.organizationId) } }, select: { id: true, slug: true, name: true, nameEn: true } });
    return rows.map((r) => ({ ...orgs.find((o) => o.id === r.organizationId)!, role: r.role }));
  });
  return { user: u, memberships };
}

export async function updateProfile(userId: string, input: z.output<typeof profileSchema>) {
  await db.user.update({ where: { id: userId }, data: input });
  return null;
}

/** Verifies the current password, enforces the policy, and signs out every other device. */
export async function changePassword(userId: string, currentSessionId: string, input: z.output<typeof passwordSchema>) {
  await enforceRateLimit(`pwchange:${userId}`, 5, 900);
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
  if (!u.passwordHash || !(await verifyPassword(u.passwordHash, input.current))) throw new ValidationError("errors.validation", { current: ["auth.invalidCredentials"] });
  const problems = passwordProblems(input.next);
  if (problems.length) throw new ValidationError("errors.validation", { next: problems });
  if (input.current === input.next) throw new ValidationError("errors.validation", { next: ["auth.passwordSame"] });
  await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(input.next), failedLogins: 0, lockedUntil: null } });
  await revokeAllSessions(userId, currentSessionId);
  return null;
}
