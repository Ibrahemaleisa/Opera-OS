import type { SiteCopy } from "@/content/site-copy";
import { cn } from "@/lib/utils";
import { Container, SectionMark } from "./primitives";

const CURRENT = 2; // the dot sits on Execution: where Opera's work lives

export function About({ t }: { t: SiteCopy }) {
  const a = t.about;
  return (
    <section id="about" aria-labelledby="about-title" className="bg-mist py-24 text-ink sm:py-32">
      <Container>
        <SectionMark index="01" label={a.label} />
        <div className="mt-12 grid gap-10 lg:grid-cols-12">
          <h2 id="about-title" className="reveal site-h2 lg:col-span-9">{a.statement}</h2>
          <p className="reveal site-lead text-slate lg:col-span-6 lg:col-start-7">{a.body}</p>
        </div>

        <div className="reveal mt-24">
          <h3 className="eyebrow !text-[12px]">{a.loopTitle}</h3>
          <ol className="relative mt-8 grid gap-8 lg:grid-cols-5 lg:gap-6">
            {a.stages.map((s, i) => {
              const done = i < CURRENT, now = i === CURRENT;
              return (
                <li key={s.name} className="relative ps-10 lg:ps-0 lg:pt-10" aria-current={now ? "step" : undefined}>
                  {/* connector to the next stage: solid behind us, faint ahead */}
                  {i < a.stages.length - 1 && <span aria-hidden className={cn("absolute start-[7px] top-2 h-[calc(100%+2rem)] w-px lg:start-2 lg:top-[7px] lg:h-px lg:w-[calc(100%+1.5rem)]", done ? "bg-ink" : "bg-ink/15")} />}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute start-0 top-0 rounded-full",
                      now ? "-start-[3px] -top-[3px] size-5 bg-brand-violet ring-4 ring-mist" : "size-[15px] border-[1.75px] border-ink ring-4 ring-mist",
                      done ? "bg-ink" : !now && "bg-mist",
                    )}
                  />
                  <div className="flex items-baseline gap-3">
                    <span className="tabular text-xs text-slate">{String(i + 1).padStart(2, "0")}</span>
                    <span className={cn("text-xl font-medium", !done && !now && "text-ink/70")}>{s.name}</span>
                    {now && <span className="rounded-full bg-brand-violet px-2 py-0.5 text-[11px] leading-none font-medium text-mist">{a.now}</span>}
                  </div>
                  <p className="mt-2 max-w-xs text-sm leading-relaxed text-slate">{s.body}</p>
                </li>
              );
            })}
          </ol>
        </div>
      </Container>
    </section>
  );
}
