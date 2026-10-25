const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXTENDED = "۰۱۲۳۴۵۶۷۸۹";

/** Converts Arabic-Indic / Persian digits to ASCII (common in Saudi spreadsheets). */
export function toAsciiDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (d) => {
    const i = ARABIC_INDIC.indexOf(d);
    return String(i >= 0 ? i : EXTENDED.indexOf(d));
  });
}

/**
 * Normalises what a person types into a numeric field so that Arabic keyboards work:
 * Arabic-Indic and Persian digits become ASCII, the Arabic decimal separator (٫) and a
 * comma used as decimal become ".", thousands separators (٬, Latin "," when a "." is
 * also present, spaces, NBSP) are dropped, and the Arabic minus/dash forms become "-".
 * Anything else is left in place so validation can still flag it.
 */
export function normalizeNumberInput(input: string): string {
  let s = toAsciiDigits(input)
    .replace(/[٬  \s]/g, "") // Arabic thousands separator, (narrow) no-break space, spaces
    .replace(/٫/g, ".") // Arabic decimal separator
    .replace(/[−‒–—‐]/g, "-"); // minus sign and dash variants
  if (s.includes(".")) s = s.replace(/,/g, "");
  else if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(/,/g, ".");
  return s;
}

/**
 * The in-place version used while someone types: converts digits and Arabic separators only, and
 * leaves Latin commas alone (typing "1,500" must not turn into "1.500" half-way); the comma is
 * resolved by normalizeNumberInput / parseNumberInput when the value is read.
 */
export function normalizeNumberTyping(input: string): string {
  return toAsciiDigits(input)
    .replace(/[\u066C\u00A0\u202F]/g, "")
    .replace(/\u066B/g, ".")
    .replace(/[\u2212\u2012\u2013\u2014\u2010]/g, "-");
}

/** Parses a typed number after normalisation; empty input is null, anything unparsable is NaN. */
export function parseNumberInput(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = normalizeNumberInput(String(input));
  if (s === "") return null;
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : Number.NaN;
}

/** Digits-only identifiers (CR, VAT, IBAN-like codes): ASCII digits, separators removed. */
export function normalizeDigitsInput(input: string): string {
  return toAsciiDigits(input).replace(/[\s  \-٬,.]/g, "");
}
