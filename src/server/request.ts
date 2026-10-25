import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { validateSessionToken } from "@/server/auth/session-store";
import { loadServiceContext } from "@/server/authz/load-context";
import type { ServiceContext } from "@/server/authz/context";
import { can } from "@/server/authz/policy";
import { homePathFor, isClientRole } from "@/server/authz/roles";
import { UnauthenticatedError, NotFoundError } from "@/server/errors";

export const SESSION_COOKIE = "operra_session";

export const getSession = cache(async () => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSessionToken(token);
});

export async function requestMeta() {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  return { ip, userAgent: h.get("user-agent") };
}

export const getOrgContext = cache(async (orgSlug: string): Promise<ServiceContext | null> => {
  const session = await getSession();
  if (!session) return null;
  const ctx = await loadServiceContext(session.user, orgSlug);
  if (!ctx) return null;
  ctx.request = await requestMeta();
  return ctx;
});

/** The four UI surfaces. Each page must state which one it belongs to (default: agency workspace). */
export type Surface = "workspace" | "portal" | "vendor" | "field";

const SURFACE_ROOT: Record<Surface, string> = { workspace: "/o", portal: "/portal", vendor: "/vendor", field: "/field" };

/** Whether the caller's role may use a surface. External roles never reach the agency workspace. */
export function fitsSurface(ctx: Pick<ServiceContext, "role" | "permissions">, surface: Surface): boolean {
  switch (surface) {
    case "workspace":
      return !isClientRole(ctx.role) && ctx.role !== "FIELD_AGENT" && ctx.role !== "VENDOR";
    case "portal":
      return isClientRole(ctx.role);
    case "vendor":
      return ctx.role === "VENDOR";
    case "field":
      return can(ctx as ServiceContext, "delivery.field");
  }
}

/**
 * For pages/layouts: redirects to login, 404s on non-membership, and sends a role that doesn't fit
 * the surface to its own home. Every page calls this itself — a layout redirect does not stop a
 * page segment from rendering (Next.js partial rendering), so the gate must live here.
 */
export async function requirePageContext(orgSlug: string, surface: Surface = "workspace"): Promise<ServiceContext> {
  const session = await getSession();
  if (!session) redirect(`/login?next=${SURFACE_ROOT[surface]}/${encodeURIComponent(orgSlug)}`);
  const ctx = await getOrgContext(orgSlug);
  if (!ctx) notFound();
  if (!fitsSurface(ctx, surface)) {
    const home = homePathFor(ctx.role, ctx.orgSlug);
    // a role whose home is this very surface but lacks its permission (custom role) must not loop
    if (home.startsWith(`${SURFACE_ROOT[surface]}/`)) notFound();
    redirect(home);
  }
  return ctx;
}

/** For server actions and route handlers: throws typed errors. */
export async function requireActionContext(orgSlug: string): Promise<ServiceContext> {
  const session = await getSession();
  if (!session) throw new UnauthenticatedError();
  const ctx = await getOrgContext(orgSlug);
  if (!ctx) throw new NotFoundError();
  return ctx;
}

/**
 * Post-login redirect target: only a same-origin, root-relative path. Rejects protocol-relative
 * ("//x", "/\\x"), schemes, backslashes, control characters and their percent-encoded variants.
 */
export function safeNextPath(next: unknown): string | null {
  if (typeof next !== "string" || !next || next.length > 2048) return null;
  let decoded = next;
  for (let i = 0; i < 3; i++) {
    try {
      const d = decodeURIComponent(decoded);
      if (d === decoded) break;
      decoded = d;
    } catch {
      return null;
    }
  }
  for (const v of [next, decoded]) {
    if (!v.startsWith("/") || v.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(v)) return null;
  }
  try {
    const base = "http://same-origin.invalid";
    const u = new URL(next, base);
    if (u.origin !== base) return null;
    // Dot segments normalise away ("/..//evil" → "//evil"), so check what is actually returned too.
    const out = u.pathname + u.search + u.hash;
    return out.startsWith("//") ? null : out;
  } catch {
    return null;
  }
}

export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session.user;
}
