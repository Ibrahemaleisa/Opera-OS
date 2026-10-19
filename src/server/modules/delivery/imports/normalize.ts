import { toAsciiDigits } from "@/lib/digits";
import { normalizeSaudiPhone } from "@/lib/phone";
import type { CanonicalKey } from "./canonical";
import { normalizeHeader } from "./canonical";

export type Mapping = Partial<Record<CanonicalKey | `cf:${string}`, string>>;
export type MatchRule = "mobile" | "email" | "externalRef" | "name";

export interface ImportOptions {
  duplicateScope: "PROJECT" | "ORGANIZATION";
  matchOn: MatchRule[];
  requireMobile: boolean;
  requireLocation: boolean;
  defaultCity?: string | null;
}

export const DEFAULT_OPTIONS: ImportOptions = { duplicateScope: "PROJECT", matchOn: ["mobile", "externalRef", "name"], requireMobile: true, requireLocation: true, defaultCity: null };

export interface Issue {
  field: string;
  code: string;
}

export interface NormalizedRecipient {
  externalRef?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  honorific?: string | null;
  jobTitle?: string | null;
  organizationName?: string | null;
  vipTier?: string | null;
  category?: string | null;
  mobile?: string | null;
  mobileRaw?: string | null;
  altPhone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  district?: string | null;
  mapsUrl?: string | null;
  lat?: number | null;
  lng?: number | null;
  deliveryInstructions?: string | null;
  preferredWindow?: string | null;
  invitationType?: string | null;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  notes?: string | null;
  custom?: Record<string, string | number | null>;
}

export interface NormalizeResult {
  normalized: NormalizedRecipient;
  errors: Issue[];
  warnings: Issue[];
  keys: string[];
}

const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;

function text(v: unknown, max = 500): string | null {
  if (v === null || v === undefined) return null;
  const s = toAsciiDigits(String(v)).replace(/[​-‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

const PRIORITY_MAP: Record<string, NormalizedRecipient["priority"]> = {
  low: "LOW", منخفضه: "LOW", منخفض: "LOW", عادي: "LOW", عاديه: "LOW",
  medium: "MEDIUM", normal: "MEDIUM", متوسط: "MEDIUM", متوسطه: "MEDIUM",
  high: "HIGH", عالي: "HIGH", عاليه: "HIGH", مهم: "HIGH", vip: "HIGH",
  critical: "CRITICAL", urgent: "CRITICAL", حرج: "CRITICAL", حرجه: "CRITICAL", عاجل: "CRITICAL", vvip: "CRITICAL",
};

/** Extracts coordinates from common Google Maps URL shapes. Short links cannot be resolved offline. */
export function coordsFromMapsUrl(url: string): { lat: number; lng: number } | null {
  const patterns = [/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/, /[?&](?:q|query|ll|destination|center)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i, /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/];
  for (const p of patterns) {
    const mm = p.exec(url);
    if (mm) {
      const lat = Number(mm[1]);
      const lng = Number(mm[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

export function isSafeMapsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return /(^|\.)google\.[a-z.]+$|(^|\.)goo\.gl$|(^|\.)maps\.app\.goo\.gl$|(^|\.)apple\.com$|(^|\.)openstreetmap\.org$|(^|\.)waze\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Rough Saudi Arabia bounding box, used only to warn about likely swapped/foreign coordinates. */
function insideSaudi(lat: number, lng: number) {
  return lat >= 16 && lat <= 32.5 && lng >= 34.4 && lng <= 55.8;
}

export function foldName(s: string | null | undefined): string {
  if (!s) return "";
  return normalizeHeader(s)
    .replace(/^(?:(?:سمو|معالي|سعادة|سعاده|الشيخ|الدكتور|د|م|الاستاذ|الأستاذ|الامير|الأمير|الاميرة|الأميرة|his|her|excellency|highness|dr|mr|mrs|ms|eng|sheikh|prince|princess|hrh|he)\s+)+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchKeys(n: NormalizedRecipient, rules: MatchRule[]): string[] {
  const keys: string[] = [];
  if (rules.includes("mobile") && n.mobile) keys.push(`m:${n.mobile}`);
  if (rules.includes("email") && n.email) keys.push(`e:${n.email.toLowerCase()}`);
  if (rules.includes("externalRef") && n.externalRef) keys.push(`r:${n.externalRef.toLowerCase()}`);
  if (rules.includes("name")) {
    const name = foldName(n.nameAr || n.nameEn);
    if (name) keys.push(nameKey(n));
  }
  return keys;
}

export function nameKey(n: Pick<NormalizedRecipient, "nameAr" | "nameEn" | "organizationName">): string {
  return `n:${foldName(n.nameAr || n.nameEn)}|${foldName(n.organizationName)}`;
}

/**
 * Maps a raw spreadsheet row to canonical recipient fields and validates it.
 * Pure function — unit tested — used by preview, validation jobs and inline row edits.
 */
export function normalizeRow(raw: Record<string, unknown>, mapping: Mapping, opts: ImportOptions, overrides?: Partial<NormalizedRecipient> | null): NormalizeResult {
  const get = (k: string) => (mapping[k as CanonicalKey] ? raw[mapping[k as CanonicalKey]!] : undefined);
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const n: NormalizedRecipient = {
    externalRef: text(get("externalRef"), 100),
    nameAr: text(get("nameAr"), 200),
    nameEn: text(get("nameEn"), 200),
    honorific: text(get("honorific"), 100),
    jobTitle: text(get("jobTitle"), 200),
    organizationName: text(get("organizationName"), 200),
    vipTier: text(get("vipTier"), 50),
    category: text(get("category"), 100),
    address: text(get("address"), 500),
    city: text(get("city"), 100),
    district: text(get("district"), 100),
    deliveryInstructions: text(get("deliveryInstructions"), 1000),
    preferredWindow: text(get("preferredWindow"), 100),
    invitationType: text(get("invitationType"), 100),
    notes: text(get("notes"), 2000),
  };
  // Name columns are frequently swapped in client spreadsheets.
  if (n.nameAr && !ARABIC.test(n.nameAr) && LATIN.test(n.nameAr) && !n.nameEn) {
    n.nameEn = n.nameAr;
    n.nameAr = null;
    warnings.push({ field: "nameAr", code: "NAME_LANG_SWAPPED" });
  } else if (n.nameEn && ARABIC.test(n.nameEn) && !n.nameAr) {
    n.nameAr = n.nameEn;
    n.nameEn = null;
    warnings.push({ field: "nameEn", code: "NAME_LANG_SWAPPED" });
  }

  const mobileRaw = get("mobile");
  if (mobileRaw !== undefined && mobileRaw !== null && String(mobileRaw).trim() !== "") {
    const p = normalizeSaudiPhone(mobileRaw);
    n.mobileRaw = text(mobileRaw, 50);
    if (!p.valid) errors.push({ field: "mobile", code: "MOBILE_INVALID" });
    else {
      n.mobile = p.e164;
      if (!p.isMobile) warnings.push({ field: "mobile", code: "MOBILE_NOT_MOBILE" });
      if (!p.isSaudi) warnings.push({ field: "mobile", code: "MOBILE_FOREIGN" });
    }
  }
  const alt = get("altPhone");
  if (alt !== undefined && alt !== null && String(alt).trim() !== "") {
    const p = normalizeSaudiPhone(alt);
    if (p.valid) n.altPhone = p.e164;
    else warnings.push({ field: "altPhone", code: "PHONE_INVALID" });
  }
  const email = text(get("email"), 200);
  if (email) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) n.email = email.toLowerCase();
    else warnings.push({ field: "email", code: "EMAIL_INVALID" });
  }
  const url = text(get("mapsUrl"), 1000);
  if (url) {
    if (isSafeMapsUrl(url)) {
      n.mapsUrl = url;
      const c = coordsFromMapsUrl(url);
      if (c) {
        n.lat = c.lat;
        n.lng = c.lng;
      }
    } else warnings.push({ field: "mapsUrl", code: "MAPS_URL_INVALID" });
  }
  const lat = get("lat");
  const lng = get("lng");
  if (lat !== undefined && lat !== null && lng !== undefined && lng !== null && String(lat) !== "" && String(lng) !== "") {
    const la = Number(toAsciiDigits(String(lat)));
    const lo = Number(toAsciiDigits(String(lng)));
    if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
      n.lat = la;
      n.lng = lo;
    } else errors.push({ field: "lat", code: "COORD_INVALID" });
  }
  if (n.lat != null && n.lng != null && !insideSaudi(n.lat, n.lng)) {
    if (insideSaudi(n.lng, n.lat)) {
      [n.lat, n.lng] = [n.lng, n.lat];
      warnings.push({ field: "lat", code: "COORD_SWAPPED" });
    } else warnings.push({ field: "lat", code: "OUTSIDE_SAUDI" });
  }
  const pr = text(get("priority"), 30);
  if (pr) {
    const mapped = PRIORITY_MAP[normalizeHeader(pr)];
    if (mapped) n.priority = mapped;
    else warnings.push({ field: "priority", code: "PRIORITY_UNKNOWN" });
  }
  if (!n.city && opts.defaultCity) n.city = opts.defaultCity;

  // custom fields
  for (const [k, header] of Object.entries(mapping)) {
    if (!k.startsWith("cf:") || !header) continue;
    const v = raw[header];
    (n.custom ??= {})[k.slice(3)] = v === undefined || v === "" ? null : typeof v === "number" ? v : text(v, 500);
  }

  // user overrides from the review grid are applied last, then re-validated below
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (k === "mobile" && typeof v === "string") {
        const p = normalizeSaudiPhone(v);
        const idx = errors.findIndex((e) => e.field === "mobile");
        if (idx >= 0) errors.splice(idx, 1);
        n.mobileRaw = v;
        n.mobile = p.valid ? p.e164 : null;
        if (!p.valid && v.trim()) errors.push({ field: "mobile", code: "MOBILE_INVALID" });
      } else (n as Record<string, unknown>)[k] = typeof v === "string" ? text(v, 1000) : v;
    }
  }

  // required checks
  if (!n.nameAr && !n.nameEn) errors.push({ field: "nameAr", code: "NAME_REQUIRED" });
  if (opts.requireMobile && !n.mobile && !errors.some((e) => e.field === "mobile")) errors.push({ field: "mobile", code: "MOBILE_REQUIRED" });
  if (opts.requireLocation && !n.address && !n.mapsUrl && (n.lat == null || n.lng == null)) errors.push({ field: "address", code: "LOCATION_REQUIRED" });
  if (!n.city) warnings.push({ field: "city", code: "CITY_MISSING" });

  return { normalized: n, errors, warnings, keys: matchKeys(n, opts.matchOn) };
}
