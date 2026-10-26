import Image from "next/image";
import { BUILD_TO_DAY } from "@/content/field";
import type { SiteCopy } from "@/content/site-copy";
import { cn } from "@/lib/utils";
import { Container, SectionMark } from "./primitives";

const CURRENT = 2; // the dot sits on Execution: where Opera's work lives

/** A moment's label laid on a photograph: its order in the story, then what it shows. */
function Tag({ n, className, children }: { n: string; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full bg-night/70 px-3 py-1.5 text-xs text-mist backdrop-blur-sm", className)}>
      <span className="tabular text-lilac">{n}</span>
      {children}
    </span>
  );
}

export function About({ t, locale }: { t: SiteCopy; locale: "ar" | "en" }) {
  const a = t.about;
  const { title, body, before, after } = BUILD_TO_DAY;
  return (
    <section id="about" aria-labelledby="about-title" className="bg-mist py-24 text-ink sm:py-32">
      <Container>
        <SectionMark index="01" label={a.label} />
        <div className="mt-12 grid gap-10 lg:grid-cols-12">
          <h2 id="about-title" className="reveal site-h2 lg:col-span-9">{a.statement}</h2>
          <p className="reveal site-lead text-slate lg:col-span-6 lg:col-start-7">{a.body}</p>
        </div>
      </Container>

      {/* the claim above, shown: one hall during the build, bleeding off the start edge, and the same
          hall on the day laid over its far corner */}
      <div className="relative mt-20 sm:mt-24 lg:mb-16">
        <div className="px-5 sm:px-8 lg:absolute lg:end-0 lg:top-0 lg:w-[36%] lg:ps-12 lg:pe-[max(3rem,calc((100vw-1320px)/2+3rem))]">
          <h3 className="reveal eyebrow !text-[12px]">{title[locale]}</h3>
          <p className="reveal mt-4 max-w-sm text-base leading-relaxed text-slate">{body[locale]}</p>
        </div>
        <div className="reveal relative mt-8 aspect-[4/5] w-full overflow-hidden bg-ink/5 sm:aspect-[16/11] lg:mt-0 lg:aspect-auto lg:h-[min(82vh,780px)] lg:w-[62%]">
          <Image src={before.src} alt={before.alt[locale]} fill sizes="(min-width: 1024px) 62vw, 100vw" className="object-cover" style={{ objectPosition: before.focus }} />
          <Tag n="01" className="absolute start-5 top-4 sm:start-8 lg:start-12 lg:top-6">{before.caption[locale]}</Tag>
        </div>
        <div className="reveal relative z-10 -mt-20 ms-auto w-[80%] pe-5 sm:-mt-28 sm:w-[58%] sm:pe-8 lg:absolute lg:end-0 lg:-bottom-16 lg:mt-0 lg:w-[44%] lg:pe-[max(3rem,calc((100vw-1320px)/2+3rem))]">
          <div className="relative aspect-[4/3] overflow-hidden bg-ink/5 ring-[10px] ring-mist">
            <Image src={after.src} alt={after.alt[locale]} fill sizes="(min-width: 1024px) 40vw, 80vw" className="object-cover" />
            <Tag n="02" className="absolute start-4 top-4">{after.caption[locale]}</Tag>
          </div>
        </div>
      </div>

      <Container>
        <div className="reveal mt-24 lg:mt-32">
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
