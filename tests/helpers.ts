import { createId } from "@/lib/id";
import { hashPassword } from "@/server/auth/password";
import type { ServiceContext } from "@/server/authz/context";
import { loadServiceContext } from "@/server/authz/load-context";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { registerAgency } from "@/server/modules/auth/service";

let counter = 0;
export function uniq(prefix = "t") {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

/** Creates an agency with an owner via the real registration path. */
export async function createAgency(name = "Agency") {
  const slug = uniq("org-");
  const email = `${slug}@example.test`;
  const r = await registerAgency({ name: `${name} Owner`, email, password: "Sup3r-Secret-Pass", orgName: name, orgSlug: slug, locale: "en" });
  const ctx = await ctxFor(r.userId, slug);
  return { ...r, slug, email, ctx };
}

export async function ctxFor(userId: string, slug: string): Promise<ServiceContext> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const ctx = await loadServiceContext(user, slug);
  if (!ctx) throw new Error(`no membership for ${userId} in ${slug}`);
  return ctx;
}

/** Adds a user with the given system role key directly (bypasses invitation flow). */
export async function addMember(owner: ServiceContext, roleKey: string, name = roleKey) {
  const userId = createId();
  const email = `${uniq(roleKey)}@example.test`;
  await withTenant({ orgId: owner.orgId, userId: owner.userId }, async (tx) => {
    await tx.user.create({ data: { id: userId, email, name, passwordHash: await hashPassword("Member-Pass-12345") } });
    const role = await tx.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: owner.orgId, key: roleKey } } });
    await tx.membership.create({ data: { organizationId: owner.orgId, userId, roleId: role.id } });
    await tx.resourceProfile.create({ data: { organizationId: owner.orgId, userId, kind: roleKey === "field_agent" ? "DRIVER" : "EMPLOYEE", dailyCapacity: roleKey === "field_agent" ? 25 : 8 } });
  });
  const ctx = await ctxFor(userId, owner.orgSlug);
  return { userId, email, ctx };
}
