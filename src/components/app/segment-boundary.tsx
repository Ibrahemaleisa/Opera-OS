"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { CircleAlert, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/client";

export type ShellBase = "o" | "portal" | "vendor" | "field";

function useHome(base: ShellBase) {
  const params = useParams<{ org?: string }>();
  return params?.org ? `/${base}/${params.org}` : "/select-org";
}

/**
 * Fallback for an error thrown inside a workspace segment (`error.tsx`). It renders inside the
 * segment's layout, so the sidebar/header stay usable, and offers a re-fetching retry.
 */
export function SegmentError({ error, retry, base }: { error: unknown; retry?: () => void; base: ShellBase }) {
  const { m } = useI18n();
  const home = useHome(base);
  const digest = error && typeof error === "object" && "digest" in error ? String((error as { digest?: unknown }).digest ?? "") : "";
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger [&_svg]:size-5"><CircleAlert aria-hidden /></span>
      <h1 className="text-lg font-medium">{m.common.pageError.title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{m.common.pageError.body}</p>
      {digest && (
        <p className="text-xs text-muted-foreground">
          {m.common.pageError.reference}: <code className="ltr-nums rounded-md bg-muted px-1.5 py-0.5">{digest}</code>
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        {retry && <Button onClick={() => retry()}>{m.common.pageError.retry}</Button>}
        <Button variant="outline" asChild><Link href={home}>{m.common.pageError.home}</Link></Button>
      </div>
    </div>
  );
}

/** 404 inside a workspace segment (`not-found.tsx`): keeps the shell and links back to its home. */
export function SegmentNotFound({ base }: { base: ShellBase }) {
  const { m } = useI18n();
  const home = useHome(base);
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5"><SearchX aria-hidden /></span>
      <p className="tabular text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-lg font-medium">{m.common.pageError.notFoundTitle}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{m.common.pageError.notFoundBody}</p>
      <Button variant="outline" asChild className="mt-1"><Link href={home}>{m.common.pageError.home}</Link></Button>
    </div>
  );
}
