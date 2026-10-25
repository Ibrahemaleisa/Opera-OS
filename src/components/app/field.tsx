"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { FieldControlContext, useFieldControl, type FieldControlContextValue } from "@/components/ui/field-context";
import { cn } from "@/lib/utils";

/**
 * Label + control + hint/error. The label is associated with the first control inside
 * (Input, Textarea, NativeSelect, NumberInput, DigitsInput) automatically, and that control gets
 * aria-invalid / aria-describedby for the error or hint. Pass `htmlFor` only when the control is
 * something else (e.g. a Radix checkbox with its own id).
 */
export function Field({ label, error, hint, children, className, required, htmlFor }: { label?: React.ReactNode; error?: string; hint?: React.ReactNode; children: React.ReactNode; className?: string; required?: boolean; htmlFor?: string }) {
  const generated = useId();
  const baseId = `field${generated.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [controlId, setControlId] = useState<string | null>(null);
  const owner = useRef<string | null>(null);
  const errorId = `${baseId}-error`;
  const hintId = `${baseId}-hint`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  const claim = useCallback((instance: string) => {
    if (owner.current === null) owner.current = instance;
    return owner.current === instance;
  }, []);
  const release = useCallback((instance: string) => {
    if (owner.current === instance) owner.current = null;
  }, []);
  const ctx = useMemo<FieldControlContextValue>(
    () => ({ id: htmlFor ?? baseId, describedBy, invalid: !!error, required, claim, release, setControlId }),
    [htmlFor, baseId, describedBy, error, required, claim, release],
  );
  return (
    <div className={cn("min-w-0", className)}>
      {label && (
        <label htmlFor={htmlFor ?? controlId ?? baseId} className="field-label">
          {label}
          {required && <span aria-hidden className="ms-0.5 text-danger">*</span>}
        </label>
      )}
      <FieldControlContext.Provider value={ctx}>{children}</FieldControlContext.Provider>
      {error ? (
        <p id={errorId} aria-live="polite" className="mt-1 text-xs text-danger">{error}</p>
      ) : hint ? (
        <p id={hintId} className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

const selectBase =
  "h-9 w-full min-w-0 rounded-md border border-input bg-card px-2.5 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50 aria-invalid:border-destructive";

/** Native select — robust in forms and excellent on mobile. */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  const wired = useFieldControl(props);
  return <select className={cn(selectBase, className)} {...wired} />;
}
