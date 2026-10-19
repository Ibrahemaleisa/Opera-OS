import { interpolate } from "./define";
import { auth } from "./dict/auth";
import { common } from "./dict/common";
import { enums } from "./dict/enums";
import { errors } from "./dict/errors";
import { nav } from "./dict/nav";
import { modules } from "./dict/modules";

const parts = { common, errors, nav, auth, enums, ...modules };
type Parts = typeof parts;

export type Messages = { [K in keyof Parts]: Parts[K]["ar"] };
export type Locale = "ar" | "en";
export const LOCALES: Locale[] = ["ar", "en"];
export const DEFAULT_LOCALE: Locale = "ar";
export const LOCALE_COOKIE = "operra_locale";

function build(locale: Locale): Messages {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parts)) out[k] = (v as { ar: unknown; en: unknown })[locale];
  return out as Messages;
}

const cache: Partial<Record<Locale, Messages>> = {};
export function getMessages(locale: Locale): Messages {
  return (cache[locale] ??= build(locale));
}

export function isLocale(v: unknown): v is Locale {
  return v === "ar" || v === "en";
}

export function dirFor(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/** Resolve a dotted key such as "errors.notFound"; returns the key itself when missing. */
export function translateKey(m: Messages, key: string, vars?: Record<string, string | number | null | undefined>): string {
  const value = key.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), m);
  return typeof value === "string" ? interpolate(value, vars) : key;
}

export { interpolate };
