import "./site.css";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { COMPANY } from "@/content/company";
import { SITE_COPY } from "@/content/site-copy";
import { getI18n } from "@/lib/i18n/server";
import { getSession } from "@/server/request";

/** The public corporate site. Shares the app's fonts, tokens, locale and session; adds no auth of its own. */
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const [{ locale }, session] = await Promise.all([getI18n(), getSession()]);
  const t = SITE_COPY[locale];
  return (
    <div className="opera-site bg-night text-base">
      <a href="#main" className="sr-only z-[60] rounded-md bg-mist px-4 py-2 text-ink focus:not-sr-only focus:fixed focus:start-4 focus:top-4">{t.skip}</a>
      <SiteHeader t={t} locale={locale} signedIn={!!session} />
      <main id="main">{children}</main>
      <SiteFooter t={t} name={COMPANY.name[locale]} />
    </div>
  );
}
