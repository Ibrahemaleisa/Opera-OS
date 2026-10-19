/**
 * Canonical recipient fields and the header synonyms used for auto-mapping.
 * Synonyms are compared after normalization (lowercase, Arabic letter folding, no punctuation).
 */
export const CANONICAL_FIELDS = [
  { key: "externalRef", ar: "الرقم المرجعي", en: "Reference ID", synonyms: ["id", "ref", "reference", "recipient id", "guest id", "رقم", "المرجع", "الرقم المرجعي", "رقم المدعو", "م", "serial", "no"] },
  { key: "nameAr", ar: "الاسم (عربي)", en: "Name (Arabic)", synonyms: ["الاسم", "اسم المدعو", "الاسم بالعربي", "الاسم العربي", "name ar", "arabic name", "الاسم الكامل", "اسم الضيف"] },
  { key: "nameEn", ar: "الاسم (إنجليزي)", en: "Name (English)", synonyms: ["name", "full name", "english name", "name en", "guest name", "الاسم بالانجليزي", "الاسم الانجليزي"] },
  { key: "honorific", ar: "اللقب", en: "Honorific / title", synonyms: ["honorific", "salutation", "prefix", "اللقب", "الصفة", "اللقب الرسمي"] },
  { key: "jobTitle", ar: "المسمى الوظيفي", en: "Job title", synonyms: ["job title", "position", "designation", "title", "المنصب", "المسمى", "المسمى الوظيفي", "الوظيفة"] },
  { key: "organizationName", ar: "الجهة", en: "Organization", synonyms: ["organization", "organisation", "company", "entity", "ministry", "الجهة", "الشركة", "جهة العمل", "المؤسسة", "الوزارة"] },
  { key: "vipTier", ar: "فئة كبار الشخصيات", en: "VIP tier", synonyms: ["vip", "tier", "vip tier", "level", "class", "الفئة", "التصنيف", "درجة الأهمية", "المستوى"] },
  { key: "category", ar: "التصنيف", en: "Category", synonyms: ["category", "group", "type", "segment", "المجموعة", "النوع", "فئة الضيف"] },
  { key: "mobile", ar: "الجوال", en: "Mobile", synonyms: ["mobile", "phone", "mobile number", "cell", "contact number", "whatsapp", "الجوال", "رقم الجوال", "الهاتف", "رقم الهاتف", "جوال", "واتساب", "رقم التواصل"] },
  { key: "altPhone", ar: "هاتف بديل", en: "Alternative phone", synonyms: ["alt phone", "alternative phone", "phone 2", "secondary phone", "office phone", "هاتف بديل", "رقم بديل", "هاتف المكتب", "جوال 2"] },
  { key: "email", ar: "البريد الإلكتروني", en: "Email", synonyms: ["email", "e-mail", "mail", "email address", "البريد", "البريد الالكتروني", "الايميل", "الإيميل"] },
  { key: "address", ar: "العنوان", en: "Address", synonyms: ["address", "street", "full address", "delivery address", "العنوان", "عنوان التوصيل", "الموقع", "العنوان الوطني", "الشارع"] },
  { key: "city", ar: "المدينة", en: "City", synonyms: ["city", "town", "المدينة", "المدينه"] },
  { key: "district", ar: "الحي", en: "District", synonyms: ["district", "neighborhood", "neighbourhood", "area", "zone", "الحي", "المنطقة", "الحى"] },
  { key: "mapsUrl", ar: "رابط الخريطة", en: "Google Maps link", synonyms: ["maps", "map", "google maps", "location link", "map link", "رابط الموقع", "رابط الخريطة", "قوقل ماب", "جوجل ماب", "الموقع على الخريطة", "لوكيشن"] },
  { key: "lat", ar: "خط العرض", en: "Latitude", synonyms: ["lat", "latitude", "خط العرض"] },
  { key: "lng", ar: "خط الطول", en: "Longitude", synonyms: ["lng", "lon", "long", "longitude", "خط الطول"] },
  { key: "deliveryInstructions", ar: "تعليمات التوصيل", en: "Delivery instructions", synonyms: ["instructions", "delivery instructions", "delivery notes", "تعليمات", "تعليمات التوصيل", "ملاحظات التوصيل"] },
  { key: "preferredWindow", ar: "وقت التوصيل المفضل", en: "Preferred delivery window", synonyms: ["window", "preferred time", "delivery window", "time slot", "الوقت المفضل", "وقت التوصيل", "وقت الاستلام"] },
  { key: "invitationType", ar: "نوع الدعوة", en: "Invitation type", synonyms: ["invitation type", "invite type", "card type", "نوع الدعوة", "نوع البطاقة"] },
  { key: "priority", ar: "الأولوية", en: "Priority", synonyms: ["priority", "urgency", "الأولوية", "الاولوية", "الأهمية"] },
  { key: "notes", ar: "ملاحظات", en: "Notes", synonyms: ["notes", "remarks", "comments", "ملاحظات", "ملاحظة"] },
] as const;

export type CanonicalKey = (typeof CANONICAL_FIELDS)[number]["key"];
export const CANONICAL_KEYS = CANONICAL_FIELDS.map((f) => f.key) as CanonicalKey[];

/** Normalizes header text for synonym matching (Arabic alef/ya/ta-marbuta folding, diacritics removed). */
export function normalizeHeader(h: string): string {
  return h
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "") // tashkeel + tatweel
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[_\-./\\()[\]:*#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SYNONYM_INDEX = new Map<string, CanonicalKey>();
for (const f of CANONICAL_FIELDS) {
  for (const s of [f.key, f.ar, f.en, ...f.synonyms]) SYNONYM_INDEX.set(normalizeHeader(s), f.key);
}

/** Suggests a mapping canonicalKey -> header from detected headers (exact synonym, then contains). */
export function suggestMapping(headers: string[]): Partial<Record<CanonicalKey, string>> {
  const out: Partial<Record<CanonicalKey, string>> = {};
  const used = new Set<string>();
  for (const h of headers) {
    const k = SYNONYM_INDEX.get(normalizeHeader(h));
    if (k && !out[k]) {
      out[k] = h;
      used.add(h);
    }
  }
  for (const h of headers) {
    if (used.has(h)) continue;
    const n = normalizeHeader(h);
    for (const [syn, k] of SYNONYM_INDEX) {
      if (out[k] || syn.length < 4) continue;
      if (n.includes(syn)) {
        out[k] = h;
        used.add(h);
        break;
      }
    }
  }
  // A single "name" column with Arabic content is resolved later by the normalizer.
  return out;
}

export function headerSignature(headers: string[]): string {
  return [...headers].map(normalizeHeader).sort().join("|");
}
