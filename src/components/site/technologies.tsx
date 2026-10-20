import { StatusRing, type RingState } from "@/components/brand/status-ring";
import type { SiteCopy } from "@/content/site-copy";
import { Container, SectionMark } from "./primitives";

const ROW_STATES: { state: RingState; value: number }[] = [
  { state: "complete", value: 1 },
  { state: "complete", value: 1 },
  { state: "inProgress", value: 0.55 },
  { state: "awaiting", value: 0.8 },
  { state: "notStarted", value: 0 },
];

export function Technologies({ t }: { t: SiteCopy }) {
  const x = t.technologies;
  return (
    // `dark` re-themes the tokens so the status rings and text read on the Night ground
    <section id="technologies" aria-labelledby="tech-title" className="dark bg-night py-24 text-mist sm:py-32">
      <Container>
        <SectionMark index="05" label={x.label} />
        <div className="mt-12 grid gap-16 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <h2 id="tech-title" className="reveal site-h2">{x.title}</h2>
            <p className="reveal site-lead mt-6 text-mist/75">{x.body}</p>
            <ul className="reveal mt-10 border-b border-mist/12">
              {x.items.map((it, i) => (
                <li key={it} className="flex items-baseline gap-4 border-t border-mist/12 py-4">
                  <span className="tabular text-xs text-lilac">{String(i + 1).padStart(2, "0")}</span>
                  <span className="text-lg">{it}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="reveal lg:col-span-5 lg:col-start-8 lg:self-center">
            <figure className="rounded-xl border border-mist/10 bg-plum p-6 [--chart-track:rgb(245_242_248/0.14)] sm:p-8">
              <figcaption className="flex items-baseline justify-between gap-4">
                <span className="text-lg font-medium">{x.panelTitle}</span>
                <span className="text-[11px] text-mist/55">{x.panelNote}</span>
              </figcaption>
              <ul className="mt-6 divide-y divide-mist/10">
                {x.rows.map((r, i) => (
                  <li key={r.name} className="flex items-center gap-4 py-3.5">
                    <StatusRing state={ROW_STATES[i].state} value={ROW_STATES[i].value} size={26} />
                    <span className="flex-1 text-[15px]">{r.name}</span>
                    <span className="text-xs text-mist/60">{r.state}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-6 border-t border-mist/10 pt-5 text-sm leading-relaxed text-mist/70">{x.proof}</p>
            </figure>
          </div>
        </div>
      </Container>
    </section>
  );
}
