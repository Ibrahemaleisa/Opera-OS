"use client";

import { useId, useState } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect } from "@/components/app/field";
import { Spinner } from "@/components/brand/spinner";
import { useI18n } from "@/lib/i18n/client";

export interface ConfirmField {
  type?: "textarea" | "text" | "select";
  label: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
}

type ConfirmResult = boolean | void | { ok: boolean } | undefined;

export interface ConfirmActionProps {
  /** The element that opens the dialog (rendered as the trigger; focus returns to it on close). */
  trigger?: React.ReactElement;
  /** Controlled mode, e.g. when opened from a dropdown item that unmounts. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element to focus when a controlled dialog closes (defaults to whatever had focus before). */
  returnFocusTo?: () => HTMLElement | null | undefined;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel: React.ReactNode;
  cancelLabel?: React.ReactNode;
  destructive?: boolean;
  /** Optional input captured with the confirmation (reason, resolution, rating…). */
  field?: ConfirmField;
  /** Runs the action. Return `false` or `{ ok: false }` to keep the dialog open (e.g. on a server error). */
  onConfirm: (value: string) => Promise<ConfirmResult> | ConfirmResult;
  testId?: string;
}

/**
 * Confirmation for destructive or irreversible actions, with an optional required input. The
 * confirm button shows a pending state, the dialog can't be dismissed mid-request, it stays open
 * when the action fails, and focus returns to the trigger when it closes.
 */
export function ConfirmAction({ trigger, open: openProp, onOpenChange, returnFocusTo, title, description, confirmLabel, cancelLabel, destructive = false, field, onConfirm, testId }: ConfirmActionProps) {
  const { m } = useI18n();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const [value, setValue] = useState(field?.defaultValue ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  // reset the input each time the dialog opens (including when opened from outside)
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setValue(field?.defaultValue ?? "");
      setError(null);
    }
  }

  const setOpen = (o: boolean) => {
    if (busy && !o) return; // never dismiss while the request is in flight
    if (openProp === undefined) setOpenState(o);
    onOpenChange?.(o);
  };

  const confirm = async () => {
    if (busy) return;
    if (field?.required && !value.trim()) {
      setError(m.common.confirmDialog.reasonRequired);
      return;
    }
    setBusy(true);
    let result: ConfirmResult;
    try {
      result = await onConfirm(value.trim());
    } catch (err) {
      console.error("[ConfirmAction]", err);
      result = false;
    } finally {
      setBusy(false);
    }
    const ok = result === undefined || result === true || (typeof result === "object" && result !== null && result.ok);
    if (ok) {
      if (openProp === undefined) setOpenState(false);
      onOpenChange?.(false);
    }
  };

  const control =
    field?.type === "select" ? (
      <NativeSelect id={inputId} value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} required={field.required}>
        {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </NativeSelect>
    ) : field?.type === "text" ? (
      <Input id={inputId} value={value} placeholder={field.placeholder} onChange={(e) => { setValue(e.target.value); setError(null); }} required={field.required} autoFocus />
    ) : field ? (
      <Textarea id={inputId} value={value} placeholder={field.placeholder} rows={3} onChange={(e) => { setValue(e.target.value); setError(null); }} required={field.required} autoFocus />
    ) : null;

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent
        data-testid={testId}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onCloseAutoFocus={(e) => {
          const el = returnFocusTo?.();
          if (el) {
            e.preventDefault();
            el.focus();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {field && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            <Field label={field.label} required={field.required} hint={field.hint} error={error ?? undefined} htmlFor={inputId}>
              {control}
            </Field>
          </form>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={busy}>{cancelLabel ?? m.common.cancel}</Button>
          </AlertDialogCancel>
          <Button variant={destructive ? "destructive" : "default"} disabled={busy} aria-busy={busy || undefined} onClick={() => void confirm()} data-testid={testId ? `${testId}-confirm` : undefined}>
            {busy && <Spinner />}
            {busy ? m.common.confirmDialog.working : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
