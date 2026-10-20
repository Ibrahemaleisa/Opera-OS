"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { LocaleToggle } from "./locale-toggle";

export function MobileMenu({ links, locale, labels, account }: { links: { href: string; label: string }[]; locale: "ar" | "en"; labels: { menu: string; close: string; language: string }; account: { href: string; label: string } }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.documentElement.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.documentElement.style.overflow = ""; };
  }, [open]);
  return (
    <>
      <button type="button" className="flex size-10 items-center justify-center rounded-md text-mist outline-none focus-visible:ring-2 focus-visible:ring-lilac lg:hidden" aria-expanded={open} aria-controls="site-menu" aria-label={open ? labels.close : labels.menu} onClick={() => setOpen((o) => !o)}>
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </button>
      {open && (
        <div id="site-menu" className="fixed inset-x-0 top-[72px] bottom-0 z-40 flex flex-col overflow-y-auto bg-night px-5 pt-6 pb-10 sm:px-8 lg:hidden">
          <nav className="flex flex-col">
            {links.map((l, i) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="hero-in flex items-baseline gap-4 border-b border-mist/10 py-5 text-3xl text-mist outline-none focus-visible:text-lilac" style={{ "--d": `${i * 40}ms` } as React.CSSProperties}>
                <span className="tabular text-sm text-lilac">{String(i + 1).padStart(2, "0")}</span>
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="mt-auto flex items-center justify-between gap-4 pt-10">
            <LocaleToggle locale={locale} label={labels.language} className="text-base" />
            <Link href={account.href} className="rounded-md border border-mist/30 px-5 py-2.5 text-sm text-mist">{account.label}</Link>
          </div>
        </div>
      )}
    </>
  );
}
