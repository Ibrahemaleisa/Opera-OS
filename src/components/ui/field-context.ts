"use client";

import { createContext, useContext, useEffect, useId, useLayoutEffect } from "react";

/**
 * Connects a <Field> (label, hint, error) to the form control rendered inside it, so labels are
 * associated and errors are announced without every call site wiring ids by hand.
 */
export interface FieldControlContextValue {
  /** id the label points at when the control doesn't bring its own */
  id: string;
  /** ids of the hint/error text describing the control */
  describedBy?: string;
  invalid: boolean;
  required?: boolean;
  /** the first control rendered inside a Field takes its id; later ones are left alone */
  claim: (instance: string) => boolean;
  release: (instance: string) => void;
  /** a control that has its own id reports it so the label can point at it */
  setControlId: (id: string | null) => void;
}

export const FieldControlContext = createContext<FieldControlContextValue | null>(null);

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: React.AriaAttributes["aria-invalid"]; "aria-required"?: React.AriaAttributes["aria-required"]; required?: boolean };

/** Merges the surrounding Field's id and ARIA wiring into a control's props. */
export function useFieldControl<P extends ControlProps>(props: P): P {
  const ctx = useContext(FieldControlContext);
  const instance = useId();
  const first = ctx ? ctx.claim(instance) : false;
  const ownId = props.id;
  useIsoLayoutEffect(() => {
    if (!ctx || !first) return;
    ctx.setControlId(ownId ?? null);
  }, [ctx, first, ownId]);
  useEffect(() => {
    if (!ctx) return;
    return () => ctx.release(instance);
  }, [ctx, instance]);
  if (!ctx || !first) return props;
  const describedBy = [props["aria-describedby"], ctx.describedBy].filter(Boolean).join(" ") || undefined;
  return {
    ...props,
    id: ownId ?? ctx.id,
    "aria-describedby": describedBy,
    "aria-invalid": props["aria-invalid"] ?? (ctx.invalid ? true : undefined),
    "aria-required": props["aria-required"] ?? (ctx.required && !props.required ? true : undefined),
  };
}
