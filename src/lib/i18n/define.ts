export type DeepString<T> = { [K in keyof T]: T[K] extends string ? string : DeepString<T[K]> };

/** Declares a message module; English must mirror the Arabic shape exactly. */
export function defineMessages<T extends Record<string, unknown>>(ar: T, en: DeepString<T>) {
  return { ar, en: en as unknown as T };
}

/** {name} interpolation */
export function interpolate(template: string, vars?: Record<string, string | number | null | undefined>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? "" : String(vars[k])));
}
