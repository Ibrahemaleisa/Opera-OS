"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect } from "@/components/app/field";
import { DigitsInput, NumberInput } from "@/components/app/number-input";
import { normalizeDigitsInput, parseNumberInput, toAsciiDigits } from "@/lib/digits";
import { ConflictNotice, type ConflictRow } from "@/components/app/conflict-notice";
import { formatDateTime, parseRiyadhDateTime, toDateTimeInput } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { ConflictDetails } from "@/server/errors";

export type FieldDef = {
  name: string;
  label: string;
  type?: "text" | "textarea" | "number" | "integer" | "digits" | "datetime" | "select" | "email" | "tel" | "checkbox";
  options?: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
  wide?: boolean;
  ltr?: boolean;
  /** allow an empty choice for selects (sent as null) */
  empty?: string;
  min?: number;
  max?: number;
};

type Values = Record<string, unknown>;

/**
 * Reads a form into typed values: datetimes are parsed in Asia/Riyadh, numbers and digit codes are
 * normalised from Arabic-Indic digits, empty strings become null (an unparsable number is NaN, which
 * the server's schema rejects with a translated message).
 */
export function readForm(form: HTMLFormElement, fields: FieldDef[]): Values {
  const fd = new FormData(form);
  const out: Values = {};
  for (const f of fields) {
    if (f.type === "checkbox") {
      out[f.name] = fd.get(f.name) === "on";
      continue;
    }
    const raw = fd.get(f.name);
    const v = typeof raw === "string" ? raw.trim() : "";
    if (f.type === "datetime") out[f.name] = v ? parseRiyadhDateTime(v) : null;
    else if (f.type === "number" || f.type === "integer") out[f.name] = parseNumberInput(v);
    else if (f.type === "digits") out[f.name] = v === "" ? null : normalizeDigitsInput(v);
    else if (f.type === "tel") out[f.name] = v === "" ? null : toAsciiDigits(v);
    else out[f.name] = v === "" ? null : v;
  }
  return out;
}

function defaultFor(f: FieldDef, v: unknown) {
  if (v === null || v === undefined) return "";
  if (f.type === "datetime") return toDateTimeInput(v as Date);
  return String(v);
}

/** A value in comparable form: the same choice reads the same whether it came from the form or the server. */
function comparable(f: FieldDef, v: unknown): string | number | boolean | null {
  if (f.type === "checkbox") return !!v;
  if (v === null || v === undefined || v === "") return null;
  if (f.type === "datetime") {
    const t = new Date(v as string | Date).getTime();
    return Number.isNaN(t) ? null : Math.round(t / 60_000); // the input has minute precision
  }
  if (f.type === "number" || f.type === "integer") return Number(v);
  return String(v);
}
const sameValue = (f: FieldDef, a: unknown, b: unknown) => comparable(f, a) === comparable(f, b);

/** A stored (JSON) value turned back into what the form submits. */
function fromStored(f: FieldDef, v: unknown): unknown {
  if (f.type === "checkbox") return !!v;
  if (v === null || v === undefined || v === "") return null;
  if (f.type === "datetime") return new Date(v as string);
  if (f.type === "number" || f.type === "integer") return Number(v);
  return v;
}

/** Writes a value into the (uncontrolled) form control for a field. */
function setControl(form: HTMLFormElement | null, f: FieldDef, v: unknown) {
  const el = form?.elements.namedItem(f.name);
  if (!el || el instanceof RadioNodeList) return;
  if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!v;
  else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) el.value = defaultFor(f, f.type === "datetime" && v ? new Date(v as string) : v);
}

/**
 * Small declarative CRUD dialog used by operational modules (events, protocol, booths, finance).
 * `extra` is merged into the submitted payload (ids, parent ids, and the loaded `version`).
 *
 * Edit conflicts (BUSINESS_RULES §6, UX note 7): pass the `conflict` from useAction (with
 * `conflictUi: "inline"`) and `onConflictResolved={clearConflict}`. The dialog then keeps what the
 * user typed, shows who saved first and a theirs/yours comparison, and offers
 * "Save my version" (re-submits only the fields the user changed, on top of the stored values, at the
 * new version — a new compare-and-set that may conflict again) or "Discard mine" (loads the stored
 * values into the form). Closing the dialog is "Cancel". There is no "overwrite anyway".
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  fields,
  values,
  extra,
  onSubmit,
  pending,
  errorFor,
  submitLabel,
  children,
  testId,
  conflict,
  onConflictResolved,
  versionKey = "version",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  fields: FieldDef[];
  values?: Values | null;
  extra?: Values;
  onSubmit: (values: Values) => void;
  pending?: boolean;
  errorFor?: (field: string) => string | undefined;
  submitLabel?: string;
  children?: React.ReactNode;
  testId?: string;
  conflict?: ConflictDetails | null;
  onConflictResolved?: () => void;
  versionKey?: string;
}) {
  const { m, fmt } = useI18n();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  // what the user loaded (replaced by the stored values after "Discard mine"), the last values they
  // submitted, and the version to send once a conflict moved them on
  const [baseline, setBaseline] = useState<Values | null>(null);
  const [mine, setMine] = useState<Values | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setBaseline(null);
      setMine(null);
      setVersion(undefined);
    }
  }
  const loaded = baseline ?? values ?? {};
  const submit = (payload: Values) => {
    const out = { ...payload, ...extra };
    if (version !== undefined) out[versionKey] = version;
    setMine(out);
    onSubmit(out);
  };
  const current = conflict?.current ?? null;
  const shown = (f: FieldDef, v: unknown): React.ReactNode => {
    if (f.type === "checkbox") return v ? m.common.yes : m.common.no;
    if (v === null || v === undefined || v === "") return m.common.conflict.empty;
    if (f.type === "datetime") return formatDateTime(v as string, fmt);
    if (f.type === "select") return f.options?.find((o) => o.value === String(v))?.label ?? String(v);
    return String(v);
  };
  const rows: ConflictRow[] =
    current && mine
      ? fields
          .filter((f) => f.name in current && !sameValue(f, current[f.name], mine[f.name]))
          // fields the other person changed (stored ≠ what this form loaded) first, then the rest of mine
          .sort((a, b) => Number(sameValue(a, current[a.name], loaded[a.name])) - Number(sameValue(b, current[b.name], loaded[b.name])))
          .map((f) => ({ name: f.name, label: f.label, theirs: shown(f, current[f.name]), yours: shown(f, mine[f.name]) }))
      : [];
  const useTheirs = (name: string) => {
    const f = fields.find((x) => x.name === name);
    if (f && current) {
      setControl(formRef.current, f, current[name]);
      setMine((x) => (x ? { ...x, [name]: fromStored(f, current[name]) } : x));
    }
  };
  /** Re-apply mine: my changed fields on top of the stored ones, at the stored version. */
  const saveMine = () => {
    if (!current || !formRef.current) return;
    const now = readForm(formRef.current, fields);
    const merged: Values = {};
    for (const f of fields) {
      if (!sameValue(f, now[f.name], loaded[f.name])) merged[f.name] = now[f.name];
      else if (f.name in current) merged[f.name] = fromStored(f, current[f.name]);
      // unchanged and not reported back (withheld from this user): left out, so the stored value stays
    }
    const nextVersion = typeof current[versionKey] === "number" ? (current[versionKey] as number) : undefined;
    const out = { ...merged, ...extra };
    if (nextVersion !== undefined) out[versionKey] = nextVersion;
    setVersion(nextVersion);
    setBaseline({ ...loaded, ...Object.fromEntries(fields.filter((f) => f.name in current).map((f) => [f.name, fromStored(f, current[f.name])])) });
    setMine(out);
    onConflictResolved?.();
    onSubmit(out);
  };
  /** Discard mine: load what's stored now into the form and continue from its version. */
  const discardMine = () => {
    if (!current) return;
    for (const f of fields) if (f.name in current) setControl(formRef.current, f, current[f.name]);
    setBaseline({ ...loaded, ...Object.fromEntries(fields.filter((f) => f.name in current).map((f) => [f.name, fromStored(f, current[f.name])])) });
    if (typeof current[versionKey] === "number") setVersion(current[versionKey] as number);
    setMine(null);
    onConflictResolved?.();
    router.refresh();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // closing is "Cancel": the lost edit is dropped with the dialog
        if (!o && conflict) onConflictResolved?.();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {conflict && <ConflictNotice conflict={conflict} rows={rows} onUseTheirs={useTheirs} />}
        <form
          ref={formRef}
          className="grid gap-3"
          data-testid={testId}
          onSubmit={(e) => {
            e.preventDefault();
            if (conflict) return saveMine();
            submit(readForm(e.currentTarget, fields));
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => {
              const dv = defaultFor(f, values?.[f.name]);
              const common = { name: f.name, id: `fd-${f.name}`, required: f.required, defaultValue: dv, dir: f.ltr || ["datetime", "number", "integer", "digits", "email", "tel"].includes(f.type ?? "") ? ("ltr" as const) : undefined };
              return (
                <Field key={f.name} label={f.type === "checkbox" ? undefined : f.label} required={f.required} hint={f.hint} error={errorFor?.(f.name)} htmlFor={common.id} className={cn((f.wide || f.type === "textarea") && "sm:col-span-2")}>
                  {f.type === "textarea" ? (
                    <Textarea {...common} rows={3} />
                  ) : f.type === "select" ? (
                    <NativeSelect {...common}>
                      {f.empty !== undefined && <option value="">{f.empty}</option>}
                      {f.options?.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </NativeSelect>
                  ) : f.type === "checkbox" ? (
                    <label className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" name={f.name} defaultChecked={!!values?.[f.name]} className="size-4" /> {f.label}</label>
                  ) : f.type === "number" || f.type === "integer" ? (
                    <NumberInput {...common} decimal={f.type === "number"} />
                  ) : f.type === "digits" || f.type === "tel" ? (
                    <DigitsInput {...common} kind={f.type === "tel" ? "tel" : "digits"} />
                  ) : (
                    <Input {...common} type={f.type === "datetime" ? "datetime-local" : f.type ?? "text"} min={f.min} max={f.max} />
                  )}
                </Field>
              );
            })}
          </div>
          {children}
          <DialogFooter>
            {conflict ? (
              <>
                <Button type="button" variant="ghost" disabled={pending} onClick={discardMine} data-testid="conflict-discard-mine">{m.common.conflict.discardMine}</Button>
                <Button type="submit" disabled={pending} data-testid="conflict-save-mine">{m.common.conflict.saveMine}</Button>
              </>
            ) : (
              <Button type="submit" disabled={pending}>{submitLabel ?? m.common.save}</Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Builds select options from an i18n enum map. */
export function enumOptions(map: Record<string, string>, keys?: readonly string[]) {
  return (keys ?? Object.keys(map)).map((k) => ({ value: k, label: map[k] ?? k }));
}
