import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeDigitsInput, normalizeNumberInput, normalizeNumberTyping, parseNumberInput, toAsciiDigits } from "@/lib/digits";
import { compactScale, formatMoney } from "@/lib/format";
import { getMessages, translateKey } from "@/lib/i18n";
import { zodI18nError } from "@/lib/zod-i18n";

describe("Arabic-Indic digit normalisation", () => {
  it("converts Arabic-Indic and Persian digits", () => {
    expect(toAsciiDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(toAsciiDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });

  it("normalises typed numbers with Arabic separators", () => {
    expect(normalizeNumberInput("٥٠٠٠")).toBe("5000");
    expect(normalizeNumberInput("١٬٢٥٠٫٥")).toBe("1250.5");
    expect(normalizeNumberInput("1,500")).toBe("1500");
    expect(normalizeNumberInput("1,250,000.75")).toBe("1250000.75");
    expect(normalizeNumberInput("12,5")).toBe("12.5");
    expect(normalizeNumberInput("−٣")).toBe("-3");
    expect(normalizeNumberInput(" ٤ ٠٠٠ ")).toBe("4000");
  });

  it("keeps Latin commas while typing so thousands aren't turned into decimals", () => {
    expect(normalizeNumberTyping("١,")).toBe("1,");
    expect(normalizeNumberTyping("١,٥٠٠")).toBe("1,500");
    expect(normalizeNumberTyping("٣٫٥")).toBe("3.5");
  });

  it("parses numbers: empty is null, junk is NaN", () => {
    expect(parseNumberInput("٥٠٠٠")).toBe(5000);
    expect(parseNumberInput("1,500")).toBe(1500);
    expect(parseNumberInput("")).toBeNull();
    expect(parseNumberInput(null)).toBeNull();
    expect(parseNumberInput("12abc")).toBeNaN();
    expect(parseNumberInput("1.2.3")).toBeNaN();
  });

  it("normalises digit-only identifiers (CR, VAT)", () => {
    expect(normalizeDigitsInput("١٠١٠٢٠٣٠٤٠")).toBe("1010203040");
    expect(normalizeDigitsInput("٣٠٠ ١٢٣ ٤٥٦٧ ٨٩٠٠٣")).toBe("300123456789003");
    expect(normalizeDigitsInput("1010-203-040")).toBe("1010203040");
  });
});

describe("compact money is deterministic (no ICU compact notation)", () => {
  it("scales and promotes units", () => {
    expect(compactScale(950, "en")).toEqual({ value: 950, suffix: "" });
    expect(compactScale(96_000, "en")).toEqual({ value: 96, suffix: "K" });
    expect(compactScale(999_960, "en")).toEqual({ value: 1, suffix: "M" });
    expect(compactScale(2_500_000_000, "ar")).toEqual({ value: 2.5, suffix: " مليار" });
  });

  it("formats the same string the browser will hydrate (uppercase K, Arabic units)", () => {
    // ICU separates the currency with a no-break space; compare on visible text
    const money = (n: number, locale: "ar" | "en", compact = true) => formatMoney(n, { locale, compact }).replace(/\u00a0/g, " ");
    expect(money(96_000, "en")).toBe("SAR 96K");
    expect(money(102_800, "en")).toBe("SAR 102.8K");
    expect(money(1_750_000, "en")).toBe("SAR 1.8M");
    expect(money(96_000, "ar")).toBe("96 ألف ر.س.");
    expect(money(-45_000, "ar")).toBe("-45 ألف ر.س.");
    expect(money(1234.5, "en", false)).toBe("SAR 1,234.50");
  });
});

describe("zod error map → i18n keys", () => {
  z.config({ customError: zodI18nError });
  const ar = getMessages("ar");
  const en = getMessages("en");
  const messages = (schema: z.ZodType, input: unknown) => {
    const r = schema.safeParse(input);
    if (r.success) return [];
    return r.error.issues.map((i) => i.message);
  };

  it("maps built-in issues to dictionary keys with bound-specific text", () => {
    const vendor = z.object({ name: z.string().trim().min(2).max(200), email: z.string().email().nullish(), count: z.number().int().min(0).max(100), kind: z.enum(["A", "B"]) });
    const [name] = messages(vendor.pick({ name: true }), { name: "ب" });
    expect(name).toBe("common.validation.minChars.2");
    expect(translateKey(ar, name)).toBe("أدخل حرفين على الأقل.");
    expect(translateKey(en, name)).toBe("Use at least 2 characters.");
    expect(messages(vendor.pick({ name: true }), { name: "x".repeat(201) })).toEqual(["common.validation.maxChars.200"]);
    expect(messages(vendor.pick({ email: true }), { email: "nope" })).toEqual(["common.validation.email"]);
    expect(messages(vendor.pick({ count: true }), { count: 101 })).toEqual(["common.validation.maxValue.100"]);
    expect(messages(vendor.pick({ count: true }), { count: 1.5 })).toEqual(["common.validation.integer"]);
    expect(messages(vendor.pick({ kind: true }), { kind: "C" })).toEqual(["common.validation.choice"]);
    expect(messages(vendor.pick({ name: true }), {})).toEqual(["common.validation.required"]);
  });

  it("falls back to generic keys for bounds without their own entry", () => {
    expect(messages(z.string().min(7), "abc")).toEqual(["common.validation.tooShort"]);
    expect(messages(z.number().max(1e11), 1e12)).toEqual(["common.validation.tooBig"]);
    expect(messages(z.array(z.string()).min(1), [])).toEqual(["common.validation.selectAtLeastOne"]);
  });

  it("keeps messages set on the schema itself", () => {
    expect(messages(z.string().regex(/^\d{10}$/, "vendors.crInvalid"), "12")).toEqual(["vendors.crInvalid"]);
  });

  it("every key it can produce exists in both dictionaries", () => {
    const produced = [
      ...messages(z.object({ a: z.string().min(2), b: z.string().max(5), c: z.number().min(10), d: z.date(), e: z.url(), f: z.string().regex(/x/), g: z.number().multipleOf(5), h: z.array(z.number()).max(2), i: z.string().length(3) }), { a: "x", b: "123456", c: 1, d: "x", e: "x", f: "y", g: 3, h: [1, 2, 3], i: "ab" }),
      "common.validation.number",
      "common.validation.invalid",
      "common.validation.dateTooEarly",
      "common.validation.dateTooLate",
      "common.validation.unknownField",
    ];
    for (const key of produced) {
      expect(translateKey(ar, key), key).not.toBe(key);
      expect(translateKey(en, key), key).not.toBe(key);
    }
  });
});
