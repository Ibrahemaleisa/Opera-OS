import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Container } from "@/components/site/primitives";
import { findProject, WORK } from "@/content/work";
import { SITE_COPY } from "@/content/site-copy";
import { getI18n } from "@/lib/i18n/server";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const [{ slug }, { locale }] = await Promise.all([params, getI18n()]);
  const p = findProject(slug);
  if (!p) return {};
  return { title: p.title[locale], description: p.summary[locale], robots: { index: true, follow: true }, alternates: { canonical: `/work/${p.slug}` }, openGraph: { title: p.title[locale], description: p.summary[locale], images: [{ url: p.cover.src }] } };
}

export default async function WorkPage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ slug }, { locale }] = await Promise.all([params, getI18n()]);
  const p = findProject(slug);
  if (!p) notFound();
  const t = SITE_COPY[locale];
  const w = t.work;
  const next = WORK[(WORK.indexOf(p) + 1) % WORK.length];
  const Back = locale === "ar" ? ArrowRight : ArrowLeft;
  const Fwd = locale === "ar" ? ArrowLeft : ArrowRight;
  const meta = [
    { k: w.category, v: t.capabilities.items[p.category].name },
    { k: w.year, v: String(p.year) },
    ...(p.location ? [{ k: w.location, v: p.location[locale] }] : []),
    ...(p.client ? [{ k: w.client, v: p.client[locale] }] : []),
  ];
  return (
    <article>
      <header className="bg-night-gradient -mt-[72px] pt-[136px] pb-16 text-mist">
        <Container>
          <Link href="/#work" className="inline-flex items-center gap-2 text-sm text-mist/70 hover:text-mist"><Back className="size-4" />{w.back}</Link>
          <h1 className="site-display mt-10 max-w-[18ch]">{p.title[locale]}</h1>
          <p className="site-lead mt-6 max-w-2xl text-mist/75">{p.summary[locale]}</p>
          <dl className="mt-12 grid grid-cols-2 gap-6 border-t border-mist/15 pt-6 sm:grid-cols-4">
            {meta.map((m) => <div key={m.k}><dt className="text-xs text-mist/55">{m.k}</dt><dd className="mt-1 text-base">{m.v}</dd></div>)}
          </dl>
        </Container>
      </header>
      <div className="bg-mist py-16 text-ink sm:py-24">
        <Container>
          <div className="relative aspect-[16/9] overflow-hidden rounded-xl bg-plum">
            <Image src={p.cover.src} alt={p.cover.alt[locale]} fill priority sizes="(min-width: 1320px) 1224px, 100vw" className="object-cover" />
          </div>
          {p.sections?.map((s) => (
            <section key={s.heading.en} className="mt-20 grid gap-6 lg:grid-cols-12">
              <h2 className="site-h3 lg:col-span-4">{s.heading[locale]}</h2>
              <p className="site-lead text-slate lg:col-span-7 lg:col-start-6">{s.body[locale]}</p>
            </section>
          ))}
          {p.gallery && p.gallery.length > 0 && (
            <div className="mt-20 grid gap-6 md:grid-cols-2">
              {p.gallery.map((g) => <div key={g.src} className="relative aspect-[4/3] overflow-hidden rounded-xl bg-plum"><Image src={g.src} alt={g.alt[locale]} fill sizes="(min-width: 768px) 600px, 100vw" className="object-cover" /></div>)}
            </div>
          )}
          {next && next.slug !== p.slug && (
            <Link href={`/work/${next.slug}`} className="group mt-24 flex items-baseline justify-between gap-6 border-t border-ink/15 pt-8">
              <span><span className="block text-sm text-slate">{w.next}</span><span className="site-h3 mt-2 block">{next.title[locale]}</span></span>
              <Fwd className="size-6 shrink-0 transition-transform duration-200 group-hover:translate-x-1 rtl:group-hover:-translate-x-1" />
            </Link>
          )}
        </Container>
      </div>
    </article>
  );
}
