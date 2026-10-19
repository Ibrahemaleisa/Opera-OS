import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import type { ServiceContext } from "@/server/authz/context";
import { AppError } from "@/server/errors";
import { requireActionContext } from "@/server/request";
import { kickOutbox } from "@/server/jobs/dispatch";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string; fieldErrors?: Record<string, string[]> };

export function toActionError(err: unknown): ActionResult<never> {
  unstable_rethrow(err);
  if (err instanceof AppError) return { ok: false, code: err.code, error: err.message, fieldErrors: err.fieldErrors };
  if (err instanceof z.ZodError) return { ok: false, code: "VALIDATION", error: "errors.validation", fieldErrors: zodFieldErrors(err) };
  const prismaCode = (err as { code?: string })?.code;
  if (prismaCode === "P2002") return { ok: false, code: "CONFLICT", error: "errors.conflict" };
  if (prismaCode === "P2025") return { ok: false, code: "NOT_FOUND", error: "errors.notFound" };
  console.error("[action] unexpected error", err);
  return { ok: false, code: "UNEXPECTED", error: "errors.unexpected" };
}

export function zodFieldErrors(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const k = issue.path.join(".") || "_";
    (out[k] ??= []).push(issue.message);
  }
  return out;
}

/**
 * Wraps an org-scoped server action: authenticates, resolves the tenant context from the
 * org slug (membership verified), validates input with Zod, maps errors to stable codes,
 * and kicks the outbox dispatcher after a successful mutation.
 */
export function orgAction<S extends z.ZodType, R>(schema: S, handler: (ctx: ServiceContext, input: z.output<S>) => Promise<R>) {
  return async (orgSlug: string, input: z.input<S>): Promise<ActionResult<R>> => {
    try {
      const ctx = await requireActionContext(orgSlug);
      const parsed = schema.safeParse(input);
      if (!parsed.success) return { ok: false, code: "VALIDATION", error: "errors.validation", fieldErrors: zodFieldErrors(parsed.error) };
      const data = await handler(ctx, parsed.data);
      void kickOutbox(ctx.orgId);
      return { ok: true, data };
    } catch (err) {
      return toActionError(err);
    }
  };
}
