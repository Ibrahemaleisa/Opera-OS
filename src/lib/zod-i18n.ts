import type { z } from "zod";
import { VALIDATION_BOUNDS } from "@/lib/i18n/dict/common";

/**
 * Zod v4 error map that turns every built-in issue into an i18n key under common.validation.
 * Server actions return these keys as field errors, and the client translates them with tk(),
 * so the Arabic UI never shows zod's English defaults ("Too small: expected string to have >=2
 * characters"). Messages set on a schema (e.g. .regex(re, "vendors.crInvalid")) still take
 * precedence over this map.
 *
 * Install once per process, before any schema parses (server/action.ts):
 *   z.config({ customError: zodI18nError });
 */
const BOUNDS = new Set<number>(VALIDATION_BOUNDS);
const K = "common.validation";

/** A bound-specific key when the dictionary has one (minChars.200), else the generic key. */
function bounded(table: string, bound: number | bigint, fallback: string): string {
  const n = typeof bound === "bigint" ? Number(bound) : bound;
  return Number.isInteger(n) && BOUNDS.has(n) ? `${K}.${table}.${n}` : `${K}.${fallback}`;
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

type RawIssue = Parameters<z.core.$ZodErrorMap>[0];

export function zodI18nError(issue: RawIssue): string | undefined {
  switch (issue.code) {
    case "invalid_type": {
      if (isEmpty(issue.input)) return `${K}.required`;
      const expected = String(issue.expected);
      if (expected === "int" && typeof issue.input === "number" && Number.isFinite(issue.input)) return `${K}.integer`;
      if (expected === "number" || expected === "int" || expected === "nan" || expected === "bigint") return `${K}.number`;
      if (expected === "date") return `${K}.date`;
      return `${K}.invalid`;
    }
    case "too_small": {
      const origin = String(issue.origin);
      if (origin === "string") {
        if (Number(issue.minimum) <= 1 && isEmpty(issue.input)) return `${K}.required`;
        return issue.exact ? bounded("exactChars", issue.minimum, "tooShort") : bounded("minChars", issue.minimum, "tooShort");
      }
      if (origin === "array" || origin === "set") return Number(issue.minimum) <= 1 ? `${K}.selectAtLeastOne` : bounded("minItems", issue.minimum, "tooSmall");
      if (origin === "date") return `${K}.dateTooEarly`;
      return issue.inclusive === false ? `${K}.tooSmall` : bounded("minValue", issue.minimum, "tooSmall");
    }
    case "too_big": {
      const origin = String(issue.origin);
      if (origin === "string") return issue.exact ? bounded("exactChars", issue.maximum, "tooLong") : bounded("maxChars", issue.maximum, "tooLong");
      if (origin === "array" || origin === "set") return bounded("maxItems", issue.maximum, "tooBig");
      if (origin === "date") return `${K}.dateTooLate`;
      return issue.inclusive === false ? `${K}.tooBig` : bounded("maxValue", issue.maximum, "tooBig");
    }
    case "invalid_format": {
      const format = String(issue.format);
      if (format === "email") return `${K}.email`;
      if (format === "url") return `${K}.url`;
      if (format === "datetime" || format === "date" || format === "time") return `${K}.date`;
      return `${K}.format`;
    }
    case "invalid_value":
      return `${K}.choice`;
    case "not_multiple_of":
      return `${K}.multipleOf`;
    case "unrecognized_keys":
      return `${K}.unknownField`;
    case "invalid_union":
    case "invalid_key":
    case "invalid_element":
    case "custom":
      return `${K}.invalid`;
    default:
      return `${K}.invalid`;
  }
}
