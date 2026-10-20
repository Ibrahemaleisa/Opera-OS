import Link from "next/link";
import { OperaWordmark } from "@/components/brand/logo";
import type { SiteCopy } from "@/content/site-copy";
import { Container } from "./primitives";

export function SiteFooter({ t, name }: { t: SiteCopy; name: string }) {
  const links = [
    { href: "/#about", label: t.nav.about },
    { href: "/#capabilities", label: t.nav.capabilities },
    { href: "/#work", label: t.nav.work },
    { href: "/#technologies", label: t.nav.technologies },
    { href: "/#contact", label: t.nav.contact },
  ];
  return (
    <footer className="bg-night text-mist">
      <Container className="grid gap-10 py-14 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <OperaWordmark tone="light" className="h-7" />
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-mist/60">{t.footer.promise}</p>
        </div>
        <nav aria-label={t.nav.menu} className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-mist/70 lg:col-span-7 lg:justify-end">
          {links.map((l) => <Link key={l.href} href={l.href} className="rounded-sm outline-none hover:text-mist focus-visible:ring-2 focus-visible:ring-lilac">{l.label}</Link>)}
          <Link href="/login" className="rounded-sm outline-none hover:text-mist focus-visible:ring-2 focus-visible:ring-lilac">{t.footer.workspace}</Link>
        </nav>
        <p className="border-t border-mist/10 pt-6 text-xs text-mist/45 lg:col-span-12">
          © <span className="tabular">{new Date().getFullYear()}</span> {name}. {t.footer.rights}
        </p>
      </Container>
    </footer>
  );
}
