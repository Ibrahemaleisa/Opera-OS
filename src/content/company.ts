/**
 * Verified company facts shown on the public site. Everything here is published as-is, so add
 * only information that has been confirmed. A `null` field is simply not shown.
 */
export interface Company {
  name: { ar: string; en: string };
  country: { ar: string; en: string };
  contact: { email: string | null; phone: string | null; address: { ar: string; en: string } | null };
}

export const COMPANY: Company = {
  name: { ar: "أوبيرا", en: "Opera" },
  country: { ar: "المملكة العربية السعودية", en: "Saudi Arabia" },
  contact: {
    email: null,
    phone: null, // E.164, e.g. "+9665XXXXXXXX"
    address: null,
  },
};
