import Image from "next/image";
import { SYMBOL } from "@/components/brand/logo-paths";
import { COMPANY } from "@/content/company";
import type { SiteCopy } from "@/content/site-copy";
import { cn } from "@/lib/utils";
import { Container, SectionMark } from "./primitives";

/** Portrait in the brand's circular frame (an open ring with its dot). Until a photo is supplied, a marked placeholder. */
function Frame({ src, alt }: { src: string | null; alt: string }) {
  return (
    <div className="relative aspect-square w-full max-w-[200px] shrink-0">
      <svg viewBox="-6 -6 112 112" className="absolute inset-0 size-full" aria-hidden style={{ direction: "ltr" }}>
        <path d={SYMBOL.ring} fill="none" stroke="var(--ink)" strokeWidth={2.4} />
        <circle cx={SYMBOL.dot.cx} cy={SYMBOL.dot.cy} r={4.8} fill="var(--brand-violet)" />
      </svg>
      <div className="absolute inset-[11%] overflow-hidden rounded-full bg-[radial-gradient(120%_120%_at_30%_20%,var(--lilac)_0%,#9a6bc4_45%,var(--aubergine)_100%)]">
        {src ? <Image src={src} alt={alt} fill sizes="200px" className="object-cover" /> : null}
      </div>
      {!src && <span className="absolute inset-0 flex items-center justify-center text-xs text-mist/85">[{alt}]</span>}
    </div>
  );
}

export function Leadership({ t, locale }: { t: SiteCopy; locale: "ar" | "en" }) {
  const l = t.leadership;
  return (
    <section id="leadership" aria-labelledby="lead-title" className="bg-mist py-24 text-ink sm:py-32">
      <Container>
        <SectionMark index="06" label={l.label} />
        <h2 id="lead-title" className="sr-only">{l.title}</h2>
        <ul className="mt-14 grid gap-16 sm:grid-cols-2 lg:gap-6">
          {COMPANY.leadership.map((p) => (
            <li key={p.name.en} className="reveal flex flex-col gap-8 border-t border-ink/10 pt-10 lg:flex-row lg:items-center">
              <Frame src={p.portrait} alt={p.portrait ? p.name[locale] : locale === "ar" ? "صورة" : "Portrait"} />
              <div>
                <p className="site-h3">{p.name[locale]}</p>
                <p className={cn("mt-2 text-base", p.title ? "text-slate" : "text-slate/70")}>{p.title ? p.title[locale] : l.titlePlaceholder}</p>
              </div>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
