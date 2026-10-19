/**
 * Deterministic synthetic data for demos, tests and sample import files.
 * Names are random combinations of common given/family names and fictional organizations.
 * No real VIP identities are used.
 */
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GIVEN_AR = ["عبدالله", "محمد", "فهد", "خالد", "سلطان", "نواف", "تركي", "ريم", "نورة", "سارة", "هيفاء", "لمى", "عبدالعزيز", "ماجد", "بدر", "يزيد", "رهف", "جواهر", "منيرة", "فيصل", "عمر", "هند", "دانة", "راكان"];
const GIVEN_EN = ["Abdullah", "Mohammed", "Fahad", "Khalid", "Sultan", "Nawaf", "Turki", "Reem", "Noura", "Sara", "Haifa", "Lama", "Abdulaziz", "Majed", "Bader", "Yazeed", "Rahaf", "Jawaher", "Munira", "Faisal", "Omar", "Hind", "Dana", "Rakan"];
const FAMILY_AR = ["الحربي", "القحطاني", "الدوسري", "الشمري", "العنزي", "الغامدي", "الزهراني", "المطيري", "العتيبي", "السبيعي", "البقمي", "الشهري", "العمري", "الجهني", "المالكي", "الرشيدي"];
const FAMILY_EN = ["Alharbi", "Alqahtani", "Aldosari", "Alshammari", "Alanazi", "Alghamdi", "Alzahrani", "Almutairi", "Alotaibi", "Alsubaie", "Albogami", "Alshehri", "Alamri", "Aljuhani", "Almalki", "Alrashidi"];
const HONORIFIC = ["سعادة", "معالي", "الدكتور", "الأستاذ", "المهندس", "الأستاذة", "الدكتورة"];
const TITLES = ["الرئيس التنفيذي", "نائب الرئيس", "مدير عام", "عضو مجلس الإدارة", "مستشار", "مدير إدارة الاتصال", "رئيس قطاع"];
const ORGS = ["شركة النخبة التجريبية للاستثمار", "مجموعة الأفق الوهمية", "هيئة المستقبل التجريبية", "شركة الواحة للتقنية (تجريبي)", "مؤسسة السدرة التجريبية", "بنك الريادة الافتراضي", "مجموعة المرجان الوهمية القابضة", "صندوق النماء التجريبي"];
export const CITIES: { city: string; districts: string[]; lat: number; lng: number }[] = [
  { city: "الرياض", districts: ["العليا", "الملقا", "حطين", "الياسمين", "السفارات", "النخيل", "الصحافة"], lat: 24.7136, lng: 46.6753 },
  { city: "جدة", districts: ["الشاطئ", "الروضة", "الحمراء", "أبحر الشمالية", "الزهراء"], lat: 21.5433, lng: 39.1728 },
  { city: "الدمام", districts: ["الشاطئ الغربي", "الفيصلية", "المزروعية"], lat: 26.4207, lng: 50.0888 },
  { city: "الخبر", districts: ["العقربية", "الراكة", "الحزام الذهبي"], lat: 26.2172, lng: 50.1971 },
];
const TIERS = ["VVIP", "VIP", "VIP", "Guest of Honor", "VIP"];

export interface SyntheticRecipient {
  ref: string;
  nameAr: string;
  nameEn: string;
  honorific: string;
  jobTitle: string;
  organization: string;
  tier: string;
  mobile: string;
  city: string;
  district: string;
  address: string;
  mapsUrl: string;
  window: string;
  priority: string;
  lat: number;
  lng: number;
}

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function generateRecipients(n: number, seed = 7): SyntheticRecipient[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const out: SyntheticRecipient[] = [];
  for (let i = 0; i < n; i++) {
    // unique given/family combinations (no accidental duplicates for n < 384)
    const gi = (i + seed) % GIVEN_AR.length;
    const fi = (Math.floor(i / GIVEN_AR.length) + i * 7 + seed) % FAMILY_AR.length;
    const c = pick(CITIES);
    const district = pick(c.districts);
    const lat = +(c.lat + (r() - 0.5) * 0.12).toFixed(6);
    const lng = +(c.lng + (r() - 0.5) * 0.12).toFixed(6);
    // reserved-looking synthetic numbers in the 0555xxxxxx range
    const local = `555${String(Math.floor(r() * 1_000_000)).padStart(6, "0")}`;
    const fmt = i % 5;
    const mobile = fmt === 0 ? `05${local.slice(1)}` : fmt === 1 ? `+966 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}` : fmt === 2 ? `966${local}` : fmt === 3 ? `0${local}`.replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)]) : local;
    out.push({
      ref: `G-${String(1001 + i)}`,
      nameAr: `${GIVEN_AR[gi]} ${FAMILY_AR[fi]}`,
      nameEn: `${GIVEN_EN[gi]} ${FAMILY_EN[fi]}`,
      honorific: pick(HONORIFIC),
      jobTitle: pick(TITLES),
      organization: pick(ORGS),
      tier: pick(TIERS),
      mobile,
      city: c.city,
      district,
      address: `${c.city}، حي ${district}، شارع ${Math.floor(r() * 90) + 10}، مبنى ${Math.floor(r() * 9000) + 1000}`,
      mapsUrl: `https://www.google.com/maps?q=${lat},${lng}`,
      window: pick(["09:00-12:00", "12:00-15:00", "16:00-19:00", "صباحاً", "مساءً"]),
      priority: pick(["عالية", "متوسطة", "عاجل", "high", "medium"]),
      lat,
      lng,
    });
  }
  return out;
}
