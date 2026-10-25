"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/brand/spinner";

type ButtonProps = React.ComponentProps<typeof Button>;

/**
 * A button that runs an async action and is disabled (with a spinner) until it settles, so a
 * double click never sends the request twice. Use for every one-click server action:
 *   <ActionButton action={() => cue.run({ id, status: "GO" })}>GO</ActionButton>
 */
export function ActionButton({ action, children, disabled, onClick, pendingLabel, ...props }: Omit<ButtonProps, "asChild"> & { action: () => unknown; pendingLabel?: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <Button
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-pending={busy || undefined}
      onClick={async (e) => {
        if (inFlight.current) return;
        onClick?.(e);
        if (e.defaultPrevented) return;
        inFlight.current = true;
        setBusy(true);
        try {
          await action();
        } finally {
          inFlight.current = false;
          if (mounted.current) setBusy(false);
        }
      }}
    >
      {String(props.size ?? "").startsWith("icon") ? (
        busy ? <Spinner /> : children
      ) : (
        <>
          {busy && <Spinner />}
          {busy && pendingLabel ? pendingLabel : children}
        </>
      )}
    </Button>
  );
}
