import Image from "next/image";
import Link from "next/link";
import { SYMBOL } from "@/components/brand/logo-paths";
import { HERO_PHOTO } from "@/content/field";
import type { SiteCopy } from "@/content/site-copy";
import { Container } from "./primitives";

/** The orbit: the symbol's open ring as one thin line, its dot the current moment. Never mirrored. */
function Orbit({ className }: { className?: string }) {
  return (
    <svg viewBox="-4 -4 108 108" className={className} aria-hidden>
      <path className="orbit-ring" d={SYMBOL.ring} pathLength={1} fill="none" stroke="var(--mist)" strokeOpacity={0.7} strokeWidth={0.18} />
      <circle className="orbit-dot" cx={SYMBOL.dot.cx} cy={SYMBOL.dot.cy} r={2.4} fill="var(--brand-violet)" />
    </svg>
  );
}

export function Hero({ t, country }: { t: SiteCopy; country: string }) {
  return (
    <section aria-labelledby="hero-title" className="bg-night-gradient relative isolate -mt-[72px] overflow-hidden text-mist">
      {/* a real exhibition floor, held in the brand's night: full-bleed under the words on phones,
          the far side of the page on desktop, fading into the night toward the headline */}
      <div aria-hidden className="absolute inset-y-0 end-0 -z-20 w-full lg:w-[64%] lg:ltr:[mask-image:linear-gradient(to_right,transparent_0%,black_50%)] lg:rtl:[mask-image:linear-gradient(to_left,transparent_0%,black_50%)]">
        <Image src={HERO_PHOTO.src} alt="" fill loading="eager" fetchPriority="high" sizes="(min-width: 1024px) 64vw, 100vw" className="object-cover opacity-45 lg:opacity-60" style={{ objectPosition: HERO_PHOTO.focus }} />
        <div className="absolute inset-0 bg-aubergine/25 mix-blend-multiply" />
        <div className="absolute inset-0 bg-[linear-gradient(to_top,var(--night)_0%,rgb(8_5_14/0.75)_30%,transparent_65%),linear-gradient(to_bottom,rgb(8_5_14/0.65)_0%,transparent_22%)]" />
      </div>
      <Orbit className="pointer-events-none absolute -end-[34%] top-[56px] -z-10 aspect-square w-[88%] rtl:-end-[10%] sm:-end-[18%] sm:w-[70%] sm:rtl:-end-[4%] lg:rtl:-end-[6%] lg:-end-[6%] lg:top-[88px] lg:w-[min(68vh,44vw)]" />
      <Container className="flex min-h-[100svh] flex-col pt-[136px] pb-10">
        <div className="mt-auto">
          <p className="hero-in eyebrow !text-[12px] !text-lilac" style={{ "--d": "100ms" } as React.CSSProperties}>{t.hero.eyebrow}</p>
          <h1 id="hero-title" className="site-display mt-6 max-w-[14ch]">
            <span className="hero-in block" style={{ "--d": "200ms" } as React.CSSProperties}>{t.hero.line1}</span>
            <span className="hero-in block text-lilac" style={{ "--d": "320ms" } as React.CSSProperties}>{t.hero.line2}</span>
          </h1>
        </div>
        <div className="mt-10 grid gap-8 border-t border-mist/15 pt-8 lg:grid-cols-12">
          <p className="hero-in site-lead max-w-xl text-mist/75 lg:col-span-6" style={{ "--d": "450ms" } as React.CSSProperties}>{t.hero.body}</p>
          <div className="hero-in flex flex-wrap items-start gap-3 lg:col-span-6 lg:justify-end" style={{ "--d": "520ms" } as React.CSSProperties}>
            <Link href="#about" className="inline-flex h-12 items-center rounded-md bg-brand-violet px-6 text-sm font-medium text-mist transition-colors outline-none hover:bg-aubergine focus-visible:ring-2 focus-visible:ring-lilac focus-visible:ring-offset-2 focus-visible:ring-offset-night">
              {t.hero.primary}
            </Link>
            <Link href="#capabilities" className="inline-flex h-12 items-center rounded-md border border-mist/30 px-6 text-sm font-medium text-mist transition-colors outline-none hover:border-mist focus-visible:ring-2 focus-visible:ring-lilac">
              {t.hero.secondary}
            </Link>
          </div>
        </div>
        <div className="mt-10 flex items-center justify-between text-xs text-mist/55">
          <span>{country}</span>
          <a href="#about" className="flex items-center gap-3 rounded-sm outline-none hover:text-mist focus-visible:ring-2 focus-visible:ring-lilac">
            {t.hero.scroll}
            <span className="h-8 w-px bg-mist/40" aria-hidden />
          </a>
        </div>
      </Container>
    </section>
  );
}
