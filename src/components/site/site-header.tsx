import Link from "next/link";
import { OperaWordmark } from "@/components/brand/logo";
import type { SiteCopy } from "@/content/site-copy";
import { Container } from "./primitives";
import { LocaleToggle } from "./locale-toggle";
import { MobileMenu } from "./mobile-menu";

export function SiteHeader({ t, locale, signedIn }: { t: SiteCopy; locale: "ar" | "en"; signedIn: boolean }) {
  const links = [
    { href: "/#about", label: t.nav.about },
    { href: "/#capabilities", label: t.nav.capabilities },
    { href: "/#work", label: t.nav.work },
    { href: "/#technologies", label: t.nav.technologies },
    { href: "/#contact", label: t.nav.contact },
  ];
  // signed-in users go back to their workspace; /select-org routes each role to its own dashboard
  const account = signedIn ? { href: "/select-org", label: t.nav.workspace } : { href: "/login", label: t.nav.login };
  return (
    <header className="site-header sticky top-0 z-50 text-mist">
      <Container className="flex h-[72px] items-center gap-6">
        <Link href="/" aria-label={t.nav.home} className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-lilac focus-visible:ring-offset-4 focus-visible:ring-offset-night">
          <OperaWordmark tone="light" className="h-[22px]" />
        </Link>
        <nav aria-label={t.nav.menu} className="ms-auto hidden items-center gap-1 lg:flex">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="rounded-md px-3 py-2 text-sm text-mist/75 transition-colors outline-none hover:text-mist focus-visible:ring-2 focus-visible:ring-lilac">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ms-auto flex items-center gap-2 lg:ms-4">
          <LocaleToggle locale={locale} label={t.nav.language} className="hidden sm:inline-flex" />
          <Link href={account.href} className="hidden rounded-md border border-mist/30 px-4 py-2 text-sm text-mist transition-colors outline-none hover:border-mist hover:bg-mist hover:text-night focus-visible:ring-2 focus-visible:ring-lilac sm:inline-flex">
            {account.label}
          </Link>
          <MobileMenu links={links} locale={locale} labels={{ menu: t.nav.menu, close: t.nav.close, language: t.nav.language }} account={account} />
        </div>
      </Container>
    </header>
  );
}
