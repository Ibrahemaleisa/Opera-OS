import { StatusRing, type RingState } from "@/components/brand/status-ring";
import type { SiteCopy } from "@/content/site-copy";
import { Container, SectionMark } from "./primitives";

// One illustrative project, one moment: each ring, number and line of copy states the same thing.
// The invitations ring is exactly 340 of 500; the stage design is finished work held for approval.
const ROW_STATES: { state: RingState; value: number; tone: string }[] = [
  { state: "complete", value: 1, tone: "text-mist/70" },
  { state: "awaiting", value: 1, tone: "text-warning" },
  { state: "inProgress", value: 340 / 500, tone: "text-primary" },
  { state: "notStarted", value: 0, tone: "text-mist/55" },
  { state: "notStarted", value: 0, tone: "text-mist/55" },
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
              <figcaption className="flex items-start justify-between gap-4">
                <span>
                  <span className="block text-lg font-medium">{x.panel.title}</span>
                  <span className="mt-1 block text-sm text-mist/60">{x.panel.when}</span>
                </span>
                <span className="shrink-0 rounded-full border border-mist/15 px-2.5 py-1 text-[11px] leading-none text-mist/60">{x.panel.note}</span>
              </figcaption>
              <ul className="mt-6 divide-y divide-mist/10">
                {x.panel.rows.map((r, i) => (
                  <li key={r.name} className="flex items-center gap-4 py-3.5">
                    <StatusRing state={ROW_STATES[i].state} value={ROW_STATES[i].value} size={28} />
                    <span className="min-w-0">
                      <span className="block text-[15px] font-medium">{r.name}</span>
                      <span className={`mt-0.5 block text-[13px] ${ROW_STATES[i].tone}`}>{r.state}</span>
                    </span>
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
