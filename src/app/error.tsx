"use client";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { m } = useI18n();
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-medium">{m.errors.errorTitle}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{m.errors.errorBody}</p>
      {error.digest && <code className="ltr-nums rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{error.digest}</code>}
      <Button onClick={reset} variant="outline">{m.errors.retry}</Button>
    </div>
  );
}
