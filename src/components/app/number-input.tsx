"use client";

import { Input } from "@/components/ui/input";
import { normalizeDigitsInput, normalizeNumberInput, normalizeNumberTyping, toAsciiDigits } from "@/lib/digits";

type InputProps = Omit<React.ComponentProps<typeof Input>, "type">;

/** Rewrites the field's own value before React (and the caller's onChange) read it, keeping the caret in place. */
function normalizeInPlace(el: HTMLInputElement, normalize: (s: string) => string) {
  const before = el.value;
  const after = normalize(before);
  if (after === before) return;
  const caret = el.selectionStart;
  el.value = after;
  if (caret !== null) {
    const pos = Math.max(0, caret - (before.length - after.length));
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      // some input types don't support selection
    }
  }
}

/**
 * Numeric entry that works with Arabic keyboards: Arabic-Indic digits (٠-٩), the Arabic decimal
 * (٫) and thousands (٬) separators are converted as they are typed. A text input with a numeric
 * keyboard is used on purpose — `type="number"` silently drops Arabic-Indic digits in Chromium.
 * Read the value with parseNumberInput() (or FormDialog's readForm, which does).
 */
export function NumberInput({ onChange, onBlur, decimal = true, ...props }: InputProps & { decimal?: boolean }) {
  return (
    <Input
      {...props}
      type="text"
      inputMode={decimal ? "decimal" : "numeric"}
      autoComplete={props.autoComplete ?? "off"}
      dir="ltr"
      onChange={(e) => {
        normalizeInPlace(e.currentTarget, normalizeNumberTyping);
        onChange?.(e);
      }}
      onBlur={(e) => {
        // on leaving the field, resolve separators too ("1,500" → "1500"); notify a controlled owner
        const before = e.currentTarget.value;
        normalizeInPlace(e.currentTarget, normalizeNumberInput);
        if (e.currentTarget.value !== before) onChange?.(e as unknown as React.ChangeEvent<HTMLInputElement>);
        onBlur?.(e);
      }}
    />
  );
}

/**
 * Digit-only identifiers (CR, VAT, national ID, IBAN digits) and phone numbers. Arabic-Indic digits
 * become ASCII; for `kind="digits"` spaces and separators are removed as well.
 */
export function DigitsInput({ onChange, kind = "digits", ...props }: InputProps & { kind?: "digits" | "tel" }) {
  return (
    <Input
      {...props}
      type={kind === "tel" ? "tel" : "text"}
      inputMode={kind === "tel" ? "tel" : "numeric"}
      autoComplete={props.autoComplete ?? (kind === "tel" ? "tel" : "off")}
      dir="ltr"
      onChange={(e) => {
        normalizeInPlace(e.currentTarget, kind === "tel" ? toAsciiDigits : normalizeDigitsInput);
        onChange?.(e);
      }}
    />
  );
}
