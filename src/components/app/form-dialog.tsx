"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect } from "@/components/app/field";
import { parseRiyadhDateTime, toDateTimeInput } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export type FieldDef = {
  name: string;
  label: string;
  type?: "text" | "textarea" | "number" | "datetime" | "select" | "email" | "tel" | "checkbox";
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

/** Reads a form into typed values: datetimes are parsed in Asia/Riyadh, empty strings become null. */
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
    else if (f.type === "number") out[f.name] = v === "" ? null : Number(v);
    else out[f.name] = v === "" ? null : v;
  }
  return out;
}

function defaultFor(f: FieldDef, v: unknown) {
  if (v === null || v === undefined) return "";
  if (f.type === "datetime") return toDateTimeInput(v as Date);
  return String(v);
}

/**
 * Small declarative CRUD dialog used by operational modules (events, protocol, booths, finance).
 * `extra` is merged into the submitted payload (ids, parent ids).
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
}) {
  const { m } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          data-testid={testId}
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit({ ...readForm(e.currentTarget, fields), ...extra });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => {
              const dv = defaultFor(f, values?.[f.name]);
              const common = { name: f.name, id: `fd-${f.name}`, required: f.required, defaultValue: dv, dir: f.ltr || ["datetime", "number", "email", "tel"].includes(f.type ?? "") ? ("ltr" as const) : undefined };
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
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={f.name} defaultChecked={!!values?.[f.name]} /> {f.label}</label>
                  ) : (
                    <Input {...common} type={f.type === "datetime" ? "datetime-local" : f.type ?? "text"} min={f.min} max={f.max} />
                  )}
                </Field>
              );
            })}
          </div>
          {children}
          <DialogFooter>
            <Button type="submit" disabled={pending}>{submitLabel ?? m.common.save}</Button>
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
