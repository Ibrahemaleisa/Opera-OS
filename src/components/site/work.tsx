import Image from "next/image";
import Link from "next/link";
import { FIELD, TEAM_PHOTO } from "@/content/field";
import { WORK, type WorkProject } from "@/content/work";
import type { SiteCopy } from "@/content/site-copy";
import { cn } from "@/lib/utils";
import { Container, SectionMark } from "./primitives";

function ProjectTile({ p, t, locale, feature }: { p: WorkProject; t: SiteCopy; locale: "ar" | "en"; feature?: boolean }) {
  return (
    <Link href={`/work/${p.slug}`} className="group block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-brand-violet focus-visible:ring-offset-4">
      <div className={cn("relative overflow-hidden rounded-xl bg-plum", feature ? "aspect-[16/9]" : "aspect-[4/3]")}>
        <Image src={p.cover.src} alt={p.cover.alt[locale]} fill sizes={feature ? "(min-width: 1024px) 1200px, 100vw" : "(min-width: 1024px) 600px, 100vw"} className="object-cover transition-opacity duration-300 group-hover:opacity-90" />
      </div>
      <div className="mt-5 flex items-baseline justify-between gap-6 border-t border-ink/10 pt-4">
        <h3 className={cn("font-medium", feature ? "site-h3" : "text-xl")}>{p.title[locale]}</h3>
        <span className="tabular shrink-0 text-sm text-slate">{p.year}</span>
      </div>
      <p className="mt-2 text-sm text-slate">{t.capabilities.items[p.category].name}</p>
    </Link>
  );
}

/** Named case studies when there are approved ones; always the field photographs. */
export function Work({ t, locale }: { t: SiteCopy; locale: "ar" | "en" }) {
  const w = t.work;
  const [first, ...rest] = WORK;
  return (
    <section id="work" aria-labelledby="work-title" className="bg-white py-24 text-ink sm:py-32">
      <Container>
        <SectionMark index="03" label={w.label} />
        <div className="mt-12 grid gap-8 lg:grid-cols-12">
          <h2 id="work-title" className="reveal site-h2 lg:col-span-7">{w.title}</h2>
          <p className="reveal site-lead text-slate lg:col-span-4 lg:col-start-9 lg:self-end">{w.intro}</p>
        </div>

        {first && (
          <div className="mt-14 grid gap-x-6 gap-y-16">
            <div className="reveal"><ProjectTile p={first} t={t} locale={locale} feature /></div>
            {rest.length > 0 && <div className="grid gap-x-6 gap-y-16 md:grid-cols-2">{rest.map((p) => <div key={p.slug} className="reveal"><ProjectTile p={p} t={t} locale={locale} /></div>)}</div>}
          </div>
        )}

        <ul className="mt-14 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-4">
          {FIELD.map((p) => (
            <li key={p.src} className="reveal">
              <figure>
                <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-mist">
                  <Image src={p.src} alt={p.alt[locale]} fill sizes="(min-width: 1320px) 300px, (min-width: 1024px) 23vw, 50vw" className="object-cover" />
                </div>
                <figcaption className="mt-4 border-t border-ink/10 pt-3">
                  {p.field && <span className="block text-xs text-slate">{t.capabilities.items[p.field].name}</span>}
                  <span className="mt-1 block text-[15px] leading-snug font-medium sm:text-base">{p.caption[locale]}</span>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>

        <figure className="reveal mt-16">
          <div className="relative aspect-[3/2] overflow-hidden rounded-xl bg-mist lg:aspect-[21/9]">
            <Image src={TEAM_PHOTO.src} alt={TEAM_PHOTO.alt[locale]} fill sizes="(min-width: 1320px) 1224px, 100vw" className="object-cover object-[50%_55%]" />
          </div>
          <figcaption className="site-h3 mt-5">{TEAM_PHOTO.caption[locale]}</figcaption>
        </figure>

        <div className="reveal mt-16 flex flex-col gap-6 border-t border-ink/10 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-base text-slate">{w.onRequest}</p>
          <Link href="#contact" className="inline-flex h-12 shrink-0 items-center self-start rounded-md border border-ink/20 px-6 text-sm font-medium transition-colors outline-none hover:border-ink focus-visible:ring-2 focus-visible:ring-brand-violet sm:self-auto">
            {w.ask}
          </Link>
        </div>
      </Container>
    </section>
  );
}
