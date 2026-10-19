/** Converts FormData to a plain object; empty strings become null, checkboxes "on" become true. */
export function formObject(form: HTMLFormElement): Record<string, unknown> {
  const fd = new FormData(form);
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    const value = typeof v === "string" ? (v === "" ? null : v === "on" ? true : v) : v;
    if (k.endsWith("[]")) {
      const key = k.slice(0, -2);
      ((out[key] as unknown[]) ??= []).push(value);
    } else out[k] = value;
  }
  // unchecked checkboxes
  form.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]').forEach((el) => {
    if (!el.name.endsWith("[]") && !(el.name in out)) out[el.name] = false;
  });
  form.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name$="[]"]').forEach((el) => {
    const key = el.name.slice(0, -2);
    if (!(key in out)) out[key] = [];
  });
  return out;
}
