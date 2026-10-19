import { ForbiddenError } from "@/server/errors";

/** CSRF defence for route handlers: require same-origin Origin/Referer on state-changing requests. */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) throw new ForbiddenError();
  try {
    if (new URL(origin).host !== host) throw new ForbiddenError();
  } catch {
    throw new ForbiddenError();
  }
}
