import { describe, expect, it } from "vitest";
import { vendorSchema } from "@/server/modules/vendors/service";

const base = { name: "مورد تجريبي", category: "PRINTING" };

describe("vendor registration numbers", () => {
  it("accept Arabic-Indic digits and separators, and still reject malformed numbers", () => {
    expect(vendorSchema.parse({ ...base, crNumber: "١٠١٠٢٠٣٠٤٠" }).crNumber).toBe("1010203040");
    expect(vendorSchema.parse({ ...base, crNumber: "1010 203 040" }).crNumber).toBe("1010203040");
    expect(vendorSchema.parse({ ...base, vatNumber: "٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣" }).vatNumber).toBe("300000000000003");
    expect(vendorSchema.parse({ ...base, crNumber: "" }).crNumber).toBeNull();
    expect(vendorSchema.parse({ ...base }).crNumber).toBeUndefined();
    const bad = vendorSchema.safeParse({ ...base, crNumber: "12345" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toBe("vendors.crInvalid");
  });
});
