import type { Metadata } from "next";
import { About } from "@/components/site/about";
import { Capabilities } from "@/components/site/capabilities";
import { Contact } from "@/components/site/contact";
import { Formula } from "@/components/site/formula";
import { Hero } from "@/components/site/hero";
import { Technologies } from "@/components/site/technologies";
import { Work } from "@/components/site/work";
import { COMPANY } from "@/content/company";
import { SITE_COPY } from "@/content/site-copy";
import { getI18n } from "@/lib/i18n/server";
import { appBaseUrl } from "@/server/app-url";

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await getI18n();
  const t = SITE_COPY[locale];
  return {
    title: { absolute: t.meta.title },
    description: t.meta.description,
    alternates: { canonical: "/" },
    robots: { index: true, follow: true },
    openGraph: { type: "website", siteName: COMPANY.name[locale], title: t.meta.title, description: t.meta.description, locale: locale === "ar" ? "ar_SA" : "en_US", images: [{ url: "/icon-512.png", width: 512, height: 512, alt: COMPANY.name[locale] }] },
    twitter: { card: "summary", title: t.meta.title, description: t.meta.description },
  };
}

export default async function HomePage() {
  const { locale } = await getI18n();
  const t = SITE_COPY[locale];
  const base = appBaseUrl();
  // only verified facts go into structured data
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: COMPANY.name.en,
    alternateName: COMPANY.name.ar,
    url: base,
    logo: `${base}/icon-512.png`,
    slogan: SITE_COPY.en.hero.line1 + " " + SITE_COPY.en.hero.line2,
    ...(COMPANY.contact.email ? { email: COMPANY.contact.email } : {}),
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <Hero t={t} country={COMPANY.country[locale]} />
      <About t={t} locale={locale} />
      <Capabilities t={t} />
      <Work t={t} locale={locale} />
      <Formula t={t} />
      <Technologies t={t} />
      <Contact t={t} locale={locale} />
    </>
  );
}
