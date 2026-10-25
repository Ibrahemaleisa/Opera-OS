"use client";

import { unstable_rethrow, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n/client";
import type { ActionResult } from "@/server/action";

type AnyAction<I, R> = (orgSlug: string, input: I) => Promise<ActionResult<R>>;

export interface UseActionOptions<R> {
  orgSlug: string;
  success?: string | false;
  refresh?: boolean;
  onSuccess?: (data: R) => void;
}

/** The result a call resolves with when the request never produced an answer (offline, 5xx, timeout). */
export const NETWORK_FAILURE = { ok: false, code: "NETWORK", error: "common.net.unreachable" } as const;

/**
 * Runs an org-scoped server action with pending state, translated error toasts,
 * field errors, and a router refresh on success.
 *
 * A request that fails outright (network down, server error page, timeout) never reaches the
 * route error boundary: it resolves as `{ ok: false, code: "NETWORK" }` with a toast, and the
 * caller's form state is left as it was. Redirects and not-found/forbidden signals from the
 * server keep their meaning (they are rethrown for Next.js to handle).
 */
export function useAction<I, R>(action: AnyAction<I, R>, opts: UseActionOptions<R>) {
  const { tk, m } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  // options are usually an inline object literal: keep the latest without re-creating `run`
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const run = useCallback(
    (input: I) =>
      new Promise<ActionResult<R>>((resolve) => {
        startTransition(async () => {
          const o = optsRef.current;
          let res: ActionResult<R>;
          try {
            res = await action(o.orgSlug, input);
            if (!res || typeof res !== "object" || !("ok" in res)) throw new Error("malformed action result");
          } catch (err) {
            unstable_rethrow(err);
            console.error("[useAction] request failed", err);
            toast.error(tk(NETWORK_FAILURE.error));
            resolve({ ...NETWORK_FAILURE });
            return;
          }
          if (res.ok) {
            setFieldErrors({});
            if (o.success !== false) toast.success(o.success ?? m.common.saved);
            if (o.refresh !== false) router.refresh();
            o.onSuccess?.(res.data);
          } else {
            setFieldErrors(res.fieldErrors ?? {});
            toast.error(tk(res.error));
          }
          resolve(res);
        });
      }),
    [action, router, tk, m],
  );

  const errorFor = useCallback((field: string) => (fieldErrors[field]?.[0] ? tk(fieldErrors[field][0]) : undefined), [fieldErrors, tk]);

  return { run, pending, fieldErrors, errorFor };
}
