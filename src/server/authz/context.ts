import type { OrgRole } from "@/generated/prisma/enums";

/** Resolved once per request; passed explicitly to every service function. */
export interface ServiceContext {
  userId: string;
  userName: string;
  locale: "ar" | "en";
  orgId: string;
  orgSlug: string;
  orgName: string;
  membershipId: string;
  role: OrgRole;
  roleKey: string;
  clientId: string | null;
  vendorId: string | null;
  permissions: ReadonlySet<string>;
  isPlatformAdmin: boolean;
  request?: { ip?: string | null; userAgent?: string | null };
}

/** Context for background jobs acting on behalf of the system inside one tenant. */
export function systemContext(orgId: string, orgSlug = "", actorId = "system"): ServiceContext {
  return {
    userId: actorId,
    userName: "Operra",
    locale: "ar",
    orgId,
    orgSlug,
    orgName: "",
    membershipId: "system",
    role: "OWNER",
    roleKey: "system",
    clientId: null,
    vendorId: null,
    permissions: new Set(["*"]),
    isPlatformAdmin: false,
  };
}
