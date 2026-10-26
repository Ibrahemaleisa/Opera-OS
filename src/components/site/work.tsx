import Image from "next/image";
import Link from "next/link";
import { FIELD, type FieldPhoto } from "@/content/field";
import { WORK, type WorkProject } from "@/content/work";
import type { SiteCopy } from "@/content/site-copy";
import { cn } from "@/lib/utils";
import { Container, SectionMark } from "./primitives";

function ProjectTile({ p, t, locale, feature }: { p: WorkProject; t: SiteCopy; locale: "ar" | "en"; feature?: boolean }) {
  return (
    <Link href={`/work/${p.slug}`} className="group block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-lilac focus-visible:ring-offset-4 focus-visible:ring-offset-night">
      <div className={cn("relative overflow-hidden rounded-lg bg-plum", feature ? "aspect-[16/9]" : "aspect-[4/3]")}>
        <Image src={p.cover.src} alt={p.cover.alt[locale]} fill sizes={feature ? "(min-width: 1024px) 1200px, 100vw" : "(min-width: 1024px) 600px, 100vw"} className="object-cover transition-opacity duration-300 group-hover:opacity-90" />
      </div>
      <div className="mt-5 flex items-baseline justify-between gap-6 border-t border-mist/15 pt-4">
        <h3 className={cn("font-medium", feature ? "site-h3" : "text-xl")}>{p.title[locale]}</h3>
        <span className="tabular shrink-0 text-sm text-mist/60">{p.year}</span>
      </div>
      <p className="mt-2 text-sm text-mist/60">{t.capabilities.items[p.category].name}</p>
    </Link>
  );
}

/** A photograph that carries its own caption, laid over the image's darkened foot. */
function FieldTile({ p, t, locale, sizes, className }: { p: FieldPhoto; t: SiteCopy; locale: "ar" | "en"; sizes: string; className?: string }) {
  return (
    <figure className={cn("relative isolate overflow-hidden rounded-md bg-plum", className)}>
      <Image src={p.src} alt={p.alt[locale]} fill sizes={sizes} className="-z-10 object-cover" style={{ objectPosition: p.focus }} />
      <div aria-hidden className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,rgb(8_5_14/0.88)_0%,rgb(8_5_14/0.35)_38%,transparent_62%)]" />
      <figcaption className="absolute inset-x-0 bottom-0 p-5 sm:p-7">
        {p.field && <span className="block text-xs text-lilac">{t.capabilities.items[p.field].name}</span>}
        <span className="mt-1.5 block text-lg leading-snug font-medium sm:text-2xl">{p.caption[locale]}</span>
      </figcaption>
    </figure>
  );
}

/** Named case studies when there are approved ones; always the field itself, edge to edge on phones. */
export function Work({ t, locale }: { t: SiteCopy; locale: "ar" | "en" }) {
  const w = t.work;
  const [first, ...rest] = WORK;
  const [lead, ...side] = FIELD;
  return (
    <section id="work" aria-labelledby="work-title" className="dark bg-night py-24 text-mist sm:py-32">
      <Container>
        <SectionMark index="03" label={w.label} />
        <div className="mt-12 grid gap-8 lg:grid-cols-12">
          <h2 id="work-title" className="reveal site-h2 lg:col-span-7">{w.title}</h2>
          <p className="reveal site-lead text-mist/70 lg:col-span-4 lg:col-start-9 lg:self-end">{w.intro}</p>
        </div>

        {first && (
          <div className="mt-14 grid gap-x-6 gap-y-16">
            <div className="reveal"><ProjectTile p={first} t={t} locale={locale} feature /></div>
            {rest.length > 0 && <div className="grid gap-x-6 gap-y-16 md:grid-cols-2">{rest.map((p) => <div key={p.slug} className="reveal"><ProjectTile p={p} t={t} locale={locale} /></div>)}</div>}
          </div>
        )}

        {/* desktop: one tall frame and two beside it */}
        <div className="reveal mt-14 hidden h-[min(86vh,760px)] grid-cols-12 grid-rows-2 gap-3 lg:grid">
          <FieldTile p={lead} t={t} locale={locale} sizes="(min-width: 1320px) 720px, 58vw" className="col-span-7 row-span-2" />
          {side.map((p) => <FieldTile key={p.src} p={p} t={t} locale={locale} sizes="(min-width: 1320px) 510px, 42vw" className="col-span-5" />)}
        </div>
      </Container>

      {/* phones and tablets: a row to swipe through, running off the edge */}
      <ul className="mt-12 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-5 px-5 pb-2 [scrollbar-width:none] sm:scroll-px-8 sm:px-8 lg:hidden" aria-label={w.title}>
        {FIELD.map((p) => (
          <li key={p.src} className="w-[80%] max-w-[420px] shrink-0 snap-start">
            <FieldTile p={p} t={t} locale={locale} sizes="(min-width: 640px) 420px, 80vw" className="aspect-[4/5]" />
          </li>
        ))}
      </ul>

      <Container>
        <div className="reveal mt-14 flex flex-col gap-6 border-t border-mist/15 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-base text-mist/70">{w.onRequest}</p>
          <Link href="#contact" className="inline-flex h-12 shrink-0 items-center self-start rounded-md border border-mist/30 px-6 text-sm font-medium transition-colors outline-none hover:border-mist focus-visible:ring-2 focus-visible:ring-lilac sm:self-auto">
            {w.ask}
          </Link>
        </div>
      </Container>
    </section>
  );
}
