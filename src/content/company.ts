/**
 * Verified company facts shown on the public site. Everything here is published as-is,
 * so add only information that has been confirmed. `null` renders as a clearly marked
 * placeholder (e.g. "[Title]") until the real value is supplied.
 */
export interface Leader {
  name: { ar: string; en: string };
  title: { ar: string; en: string } | null;
  /** path under /public, e.g. "/leadership/haroun.jpg" */
  portrait: string | null;
}

export interface Company {
  name: { ar: string; en: string };
  country: { ar: string; en: string };
  contact: { email: string | null; phone: string | null; address: { ar: string; en: string } | null };
  leadership: Leader[];
}

export const COMPANY: Company = {
  name: { ar: "أوبيرا", en: "Opera" },
  country: { ar: "المملكة العربية السعودية", en: "Saudi Arabia" },
  contact: {
    email: null,
    phone: null, // E.164, e.g. "+9665XXXXXXXX"
    address: null,
  },
  leadership: [
    { name: { ar: "هارون العيسى", en: "Haroun Al-Eisa" }, title: null, portrait: null },
    { name: { ar: "إبراهيم العيسى", en: "Ibrahim Al-Eisa" }, title: null, portrait: null },
  ],
};
