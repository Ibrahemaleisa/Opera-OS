import { withUser } from "@/server/db/tenant";
import type { ServiceContext } from "./context";

interface SessionUser {
  id: string;
  name: string;
  nameAr: string | null;
  locale: string;
  isPlatformAdmin: boolean;
}

/** Resolves the caller's ACTIVE membership in the org identified by slug (RLS: user-scoped). */
export async function loadServiceContext(user: SessionUser, orgSlug: string): Promise<ServiceContext | null> {
  const membership = await withUser(user.id, (tx) =>
    tx.membership.findFirst({
      where: { userId: user.id, status: "ACTIVE", organization: { slug: orgSlug } },
      include: { role: true, organization: { select: { id: true, slug: true, name: true } } },
    }),
  );
  if (!membership) return null;
  const locale = user.locale === "en" ? "en" : "ar";
  return {
    userId: user.id,
    userName: (locale === "ar" ? user.nameAr : null) ?? user.name,
    locale,
    orgId: membership.organizationId,
    orgSlug: membership.organization.slug,
    orgName: membership.organization.name,
    membershipId: membership.id,
    role: membership.role.baseRole,
    roleKey: membership.role.key,
    clientId: membership.clientId,
    vendorId: membership.vendorId,
    permissions: new Set(membership.role.permissions),
    isPlatformAdmin: user.isPlatformAdmin,
  };
}

export async function listUserOrganizations(userId: string) {
  return withUser(userId, (tx) =>
    tx.membership.findMany({
      where: { userId, status: "ACTIVE" },
      include: { role: { select: { baseRole: true, nameAr: true, nameEn: true } }, organization: { select: { id: true, slug: true, name: true, nameEn: true, brandColor: true } } },
      orderBy: { joinedAt: "asc" },
    }),
  );
}
