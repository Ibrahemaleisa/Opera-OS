import Image from "next/image";
import Link from "next/link";
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

export function Work({ t, locale }: { t: SiteCopy; locale: "ar" | "en" }) {
  const w = t.work;
  const [first, ...rest] = WORK;
  return (
    <section id="work" aria-labelledby="work-title" className="bg-white py-24 text-ink sm:py-32">
      <Container>
        <SectionMark index="04" label={w.label} />
        <h2 id="work-title" className="reveal site-h2 mt-12">{w.title}</h2>
        {first ? (
          <div className="mt-14 grid gap-x-6 gap-y-16">
            <div className="reveal"><ProjectTile p={first} t={t} locale={locale} feature /></div>
            {rest.length > 0 && <div className="grid gap-x-6 gap-y-16 md:grid-cols-2">{rest.map((p) => <div key={p.slug} className="reveal"><ProjectTile p={p} t={t} locale={locale} /></div>)}</div>}
          </div>
        ) : (
          // No invented case studies: until real projects are added to src/content/work.ts the section says so.
          <div className="reveal mt-14 grid gap-10 rounded-xl border border-ink/10 bg-mist px-6 py-14 sm:px-12 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-8">
              <p className="site-h3 max-w-2xl">{w.empty}</p>
              <p className="mt-4 text-base text-slate">{w.emptyBody}</p>
            </div>
            <div className="lg:col-span-4 lg:text-end">
              <Link href="#contact" className="inline-flex h-12 items-center rounded-md border border-ink/20 px-6 text-sm font-medium transition-colors outline-none hover:border-ink focus-visible:ring-2 focus-visible:ring-brand-violet">
                {w.ask}
              </Link>
            </div>
          </div>
        )}
      </Container>
    </section>
  );
}
