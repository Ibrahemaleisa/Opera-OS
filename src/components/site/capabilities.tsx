import { CAPABILITY_ORDER, type SiteCopy } from "@/content/site-copy";
import { Container, SectionMark } from "./primitives";

/** An editorial index, not a card grid: one row per field, read like a table of contents. */
export function Capabilities({ t }: { t: SiteCopy }) {
  const c = t.capabilities;
  return (
    <section id="capabilities" aria-labelledby="cap-title" className="dark bg-plum py-24 text-mist sm:py-32">
      <Container>
        <SectionMark index="02" label={c.label} />
        <div className="mt-12 grid gap-8 lg:grid-cols-12">
          <h2 id="cap-title" className="reveal site-h2 lg:col-span-8">{c.title}</h2>
          <p className="reveal site-lead text-mist/70 lg:col-span-4 lg:self-end">{c.intro}</p>
        </div>
        <ol className="mt-16 border-b border-mist/15">
          {CAPABILITY_ORDER.map((key, i) => {
            const item = c.items[key];
            return (
              <li key={key} className="reveal group relative grid gap-4 border-t border-mist/15 py-8 transition-colors hover:bg-mist/[0.03] sm:py-10 lg:grid-cols-12 lg:gap-6">
                <span className="tabular text-sm text-lilac lg:col-span-1 lg:pt-2">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="site-h3 flex items-start gap-3 lg:col-span-5">
                  {item.name}
                  <span aria-hidden className="mt-3 size-2 shrink-0 rounded-full bg-lilac opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
                </h3>
                <p className="max-w-xl text-base leading-relaxed text-mist/70 lg:col-span-4 lg:pt-1.5">{item.body}</p>
                <ul className="flex flex-wrap content-start gap-2 lg:col-span-2 lg:pt-2">
                  {item.tags.map((tag) => <li key={tag} className="rounded-full border border-mist/15 px-2.5 py-1 text-[11px] text-mist/70">{tag}</li>)}
                </ul>
              </li>
            );
          })}
        </ol>
      </Container>
    </section>
  );
}
