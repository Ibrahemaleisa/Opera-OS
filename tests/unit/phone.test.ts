import { describe, expect, it } from "vitest";
import { maskPhone, normalizeSaudiPhone } from "@/lib/phone";

describe("normalizeSaudiPhone", () => {
  it.each([
    ["0551234567", "+966551234567"],
    ["551234567", "+966551234567"],
    ["966551234567", "+966551234567"],
    ["+966 55 123 4567", "+966551234567"],
    ["00966551234567", "+966551234567"],
    ["٠٥٥١٢٣٤٥٦٧", "+966551234567"],
    ["055-123-4567", "+966551234567"],
    [551234567, "+966551234567"],
  ])("normalizes %s", (input, expected) => {
    const r = normalizeSaudiPhone(input);
    expect(r.valid).toBe(true);
    expect(r.e164).toBe(expected);
    expect(r.isMobile).toBe(true);
    expect(r.isSaudi).toBe(true);
  });

  it("flags landlines as valid but not mobile", () => {
    const r = normalizeSaudiPhone("0112345678");
    expect(r.valid).toBe(true);
    expect(r.isMobile).toBe(false);
    expect(r.error).toBe("NOT_MOBILE");
  });

  it("rejects junk and formula-like values", () => {
    expect(normalizeSaudiPhone("05123").valid).toBe(false);
    expect(normalizeSaudiPhone('=HYPERLINK("x")').valid).toBe(false);
    expect(normalizeSaudiPhone("").error).toBe("EMPTY");
  });

  it("masks for least-privilege display", () => {
    expect(maskPhone("+966551234567")).toBe("+966 55 ••• 4567");
  });
});
