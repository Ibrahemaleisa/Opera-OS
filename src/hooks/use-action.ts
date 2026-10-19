"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n/client";
import type { ActionResult } from "@/server/action";

type AnyAction<I, R> = (orgSlug: string, input: I) => Promise<ActionResult<R>>;

/**
 * Runs an org-scoped server action with pending state, translated error toasts,
 * field errors, and a router refresh on success.
 */
export function useAction<I, R>(action: AnyAction<I, R>, opts: { orgSlug: string; success?: string | false; refresh?: boolean; onSuccess?: (data: R) => void } ) {
  const { tk, m } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const run = useCallback(
    (input: I) =>
      new Promise<ActionResult<R>>((resolve) => {
        startTransition(async () => {
          const res = await action(opts.orgSlug, input);
          if (res.ok) {
            setFieldErrors({});
            if (opts.success !== false) toast.success(opts.success ?? m.common.saved);
            if (opts.refresh !== false) router.refresh();
            opts.onSuccess?.(res.data);
          } else {
            setFieldErrors(res.fieldErrors ?? {});
            toast.error(tk(res.error));
          }
          resolve(res);
        });
      }),
    [action, opts, router, tk, m],
  );

  const errorFor = useCallback((field: string) => (fieldErrors[field]?.[0] ? tk(fieldErrors[field][0]) : undefined), [fieldErrors, tk]);

  return { run, pending, fieldErrors, errorFor };
}
