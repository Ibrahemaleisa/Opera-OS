import { describe, expect, it } from "vitest";
import { suggestMapping } from "@/server/modules/delivery/imports/canonical";
import { coordsFromMapsUrl, DEFAULT_OPTIONS, isSafeMapsUrl, normalizeRow } from "@/server/modules/delivery/imports/normalize";
import { detectHeaderRow } from "@/server/modules/delivery/imports/parse";

describe("import mapping & normalization", () => {
  it("auto-maps Arabic and English headers", () => {
    const m = suggestMapping(["الرقم المرجعي", "الاسم", "رقم الجوال", "المدينة", "الحي", "رابط الموقع", "Company", "Full Name"]);
    expect(m).toMatchObject({ externalRef: "الرقم المرجعي", nameAr: "الاسم", mobile: "رقم الجوال", city: "المدينة", district: "الحي", mapsUrl: "رابط الموقع", organizationName: "Company", nameEn: "Full Name" });
  });

  it("detects the header row below a title row", () => {
    const grid = [["قائمة كبار المدعوين"], [], ["الاسم", "رقم الجوال", "المدينة"], ["أ", "0551234567", "الرياض"]];
    expect(detectHeaderRow(grid)).toBe(3);
  });

  it("extracts coordinates from Google Maps links and rejects unsafe URLs", () => {
    expect(coordsFromMapsUrl("https://www.google.com/maps?q=24.71,46.67")).toEqual({ lat: 24.71, lng: 46.67 });
    expect(coordsFromMapsUrl("https://www.google.com/maps/place/x/@21.54,39.17,15z")).toEqual({ lat: 21.54, lng: 39.17 });
    expect(isSafeMapsUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeMapsUrl("https://maps.app.goo.gl/abc")).toBe(true);
  });

  const mapping = { nameAr: "name", nameEn: "en", mobile: "mobile", address: "addr", city: "city", mapsUrl: "map", priority: "p" } as const;

  it("validates a good row and derives match keys", () => {
    const r = normalizeRow({ name: "سعادة فهد الحربي", mobile: "٠٥٥١٢٣٤٥٦٧", addr: "الرياض، العليا", city: "الرياض", p: "عالية" }, mapping, DEFAULT_OPTIONS);
    expect(r.errors).toEqual([]);
    expect(r.normalized.mobile).toBe("+966551234567");
    expect(r.normalized.priority).toBe("HIGH");
    expect(r.keys).toContain("m:+966551234567");
    expect(r.keys.some((k) => k.startsWith("n:فهد الحربي"))).toBe(true); // honorific stripped
  });

  it("reports required/invalid fields with stable codes", () => {
    const r = normalizeRow({ mobile: "05123" }, mapping, DEFAULT_OPTIONS);
    expect(r.errors.map((e) => e.code).sort()).toEqual(["LOCATION_REQUIRED", "MOBILE_INVALID", "NAME_REQUIRED"]);
  });

  it("fixes swapped name columns and swapped coordinates with warnings", () => {
    const r = normalizeRow({ name: "Fahad Alharbi", mobile: "0551234567", map: "https://www.google.com/maps?q=46.67,24.71" }, mapping, DEFAULT_OPTIONS);
    expect(r.normalized.nameEn).toBe("Fahad Alharbi");
    expect(r.normalized.nameAr).toBeNull();
    expect(r.normalized.lat).toBe(24.71);
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["NAME_LANG_SWAPPED", "COORD_SWAPPED", "CITY_MISSING"]));
  });

  it("applies reviewer overrides and re-validates", () => {
    const bad = normalizeRow({ name: "ريم", mobile: "05123", addr: "جدة" }, mapping, DEFAULT_OPTIONS);
    expect(bad.errors.some((e) => e.code === "MOBILE_INVALID")).toBe(true);
    const fixed = normalizeRow({ name: "ريم", mobile: "05123", addr: "جدة" }, mapping, DEFAULT_OPTIONS, { mobile: "0559876543" });
    expect(fixed.errors).toEqual([]);
    expect(fixed.normalized.mobile).toBe("+966559876543");
  });
});
