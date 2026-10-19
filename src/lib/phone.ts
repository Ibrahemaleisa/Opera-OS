import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { toAsciiDigits } from "./digits";

export interface NormalizedPhone {
  /** E.164, e.g. +966501234567 */
  e164: string | null;
  valid: boolean;
  isMobile: boolean;
  isSaudi: boolean;
  /** human display, e.g. 050 123 4567 */
  display: string | null;
  error?: "EMPTY" | "INVALID" | "NOT_MOBILE";
}

/**
 * Normalizes Saudi phone numbers as typically found in agency spreadsheets:
 * 0501234567, 501234567, 966501234567, +966 50 123 4567, 00966501234567,
 * Arabic-Indic digits, numbers stored by Excel as floats (5.01234567E8), and
 * stray punctuation. Non-Saudi international numbers are accepted when valid.
 */
export function normalizeSaudiPhone(raw: unknown): NormalizedPhone {
  if (raw === null || raw === undefined) return empty();
  let s = typeof raw === "number" ? Math.round(raw).toString() : String(raw);
  s = toAsciiDigits(s).trim();
  if (!s) return empty();
  // keep leading + and digits only
  const plus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (!s) return { ...empty(), error: "INVALID" };
  if (!plus && s.startsWith("00")) s = s.slice(2);
  let candidate: string;
  if (plus || s.startsWith("966")) candidate = `+${s}`;
  else if (s.startsWith("05") && s.length === 10) candidate = `+966${s.slice(1)}`;
  else if (s.startsWith("5") && s.length === 9) candidate = `+966${s}`;
  else if (s.startsWith("0") && s.length === 9) candidate = `+966${s.slice(1)}`; // landline 01x xxx xxxx
  else if (s.length > 10) candidate = `+${s}`;
  else candidate = `+966${s.replace(/^0/, "")}`;

  const parsed = parsePhoneNumberFromString(candidate);
  if (!parsed || !parsed.isValid()) return { e164: null, valid: false, isMobile: false, isSaudi: candidate.startsWith("+966"), display: null, error: "INVALID" };
  const type = parsed.getType();
  const isMobile = type === "MOBILE" || type === "FIXED_LINE_OR_MOBILE";
  const isSaudi = parsed.country === "SA";
  return {
    e164: parsed.number,
    valid: true,
    isMobile,
    isSaudi,
    display: isSaudi ? parsed.formatNational() : parsed.formatInternational(),
    error: isMobile ? undefined : "NOT_MOBILE",
  };
}

function empty(): NormalizedPhone {
  return { e164: null, valid: false, isMobile: false, isSaudi: false, display: null, error: "EMPTY" };
}

/** Masks a phone for least-privilege display: +966 50 ••• 4567 */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const d = e164.replace(/\D/g, "");
  if (d.length < 7) return "•••";
  return `+${d.slice(0, 3)} ${d.slice(3, 5)} ••• ${d.slice(-4)}`;
}

export function telHref(e164: string) {
  return `tel:${e164}`;
}

export function whatsappHref(e164: string) {
  return `https://wa.me/${e164.replace(/\D/g, "")}`;
}
