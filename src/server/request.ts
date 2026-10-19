import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { validateSessionToken } from "@/server/auth/session-store";
import { loadServiceContext } from "@/server/authz/load-context";
import type { ServiceContext } from "@/server/authz/context";
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

/** For pages/layouts: redirects to login, 404s on non-membership. */
export async function requirePageContext(orgSlug: string): Promise<ServiceContext> {
  const session = await getSession();
  if (!session) redirect(`/login?next=/o/${encodeURIComponent(orgSlug)}`);
  const ctx = await getOrgContext(orgSlug);
  if (!ctx) notFound();
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

export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session.user;
}
