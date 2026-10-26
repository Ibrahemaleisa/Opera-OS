"use client";

import { useState } from "react";
import type { SiteCopy } from "@/content/site-copy";
import { cn } from "@/lib/utils";
import { Container, SectionMark } from "./primitives";

// The brand ring (thickness x = 10.7, 45° gap at 11 o'clock) split into five arcs: each principle
// is one fifth of the loop, and only all five together draw the symbol.
const R = 44.65, X = 10.7, START = 107.5, SPAN = 315, GAP = 2.4, DOT = 130;
const pt = (deg: number, r = R) => [50 + r * Math.cos((deg * Math.PI) / 180), 50 - r * Math.sin((deg * Math.PI) / 180)] as const;
const SEG = SPAN / 5;
const arcs = Array.from({ length: 5 }, (_, i) => {
  const from = START - i * SEG - (i === 0 ? 0 : GAP / 2);
  const sweep = SEG - (i === 0 || i === 4 ? GAP / 2 : GAP);
  const [x1, y1] = pt(from), [x2, y2] = pt(from - sweep), mid = from - sweep / 2;
  return { d: `M${x1.toFixed(2)} ${y1.toFixed(2)}A${R} ${R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`, label: pt(mid, R + 13) };
});

export function Formula({ t }: { t: SiteCopy }) {
  const f = t.formula;
  const [active, setActive] = useState<number | null>(null);
  const [dx, dy] = pt(DOT);
  return (
    <section id="formula" aria-labelledby="formula-title" className="bg-mist py-24 text-ink sm:py-32">
      <Container>
        <SectionMark index="04" label={f.label} />
        <div className="mt-12 grid items-center gap-14 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <h2 id="formula-title" className="reveal site-h2">{f.title}</h2>
            <p className="reveal site-lead mt-6 max-w-lg text-slate">{f.intro}</p>
            <p className="mt-10 text-xs text-slate" id="formula-hint">{f.hint}</p>
            <ul className="mt-3 border-b border-ink/10" aria-describedby="formula-hint" onMouseLeave={() => setActive(null)}>
              {f.principles.map((p, i) => {
                const on = active === i;
                return (
                  <li key={p.name} className="border-t border-ink/10">
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setActive(on ? null : i)}
                      onMouseEnter={() => setActive(i)}
                      onFocus={() => setActive(i)}
                      className="group grid w-full grid-cols-[2.5rem_1fr] items-baseline gap-x-2 py-5 text-start outline-none focus-visible:bg-ink/[0.03]"
                    >
                      <span className={cn("tabular text-sm transition-colors", on ? "text-brand-violet" : "text-slate")}>{String(i + 1).padStart(2, "0")}</span>
                      <span className={cn("text-xl font-medium transition-colors sm:text-2xl", active !== null && !on && "text-ink/45")}>{p.name}</span>
                      <span className={cn("col-start-2 mt-1 text-sm leading-relaxed text-slate transition-colors", active !== null && !on && "text-slate/60")}>{p.body}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="reveal relative mx-auto w-full max-w-[520px] lg:col-span-6">
            <svg viewBox="-10 -10 120 120" className="w-full" role="img" aria-label={f.all} style={{ direction: "ltr" }}>
              {arcs.map((a, i) => (
                <g key={i} className="cursor-pointer" onMouseEnter={() => setActive(i)} onClick={() => setActive(active === i ? null : i)}>
                  <path d={a.d} fill="none" strokeWidth={X} className="transition-[stroke] duration-200" stroke={active === null || active === i ? "var(--ink)" : "rgb(23 11 38 / 0.12)"} />
                  <text x={a.label[0]} y={a.label[1]} textAnchor="middle" dominantBaseline="central" className="tabular text-[4px] transition-[fill] duration-200" fill={active === i ? "var(--brand-violet)" : "var(--slate)"}>{String(i + 1).padStart(2, "0")}</text>
                </g>
              ))}
              <circle cx={dx} cy={dy} r={X} fill="var(--brand-violet)" />
            </svg>
            {/* the centre names the principle in focus, or all five together */}
            <div className="pointer-events-none absolute inset-[24%] flex flex-col items-center justify-center text-center" aria-live="polite">
              <span dir="ltr" className="tabular text-sm text-slate">{active === null ? "01—05" : String(active + 1).padStart(2, "0")}</span>
              <span className="mt-2 text-lg leading-snug font-medium text-balance sm:text-2xl">{active === null ? f.all : f.principles[active].name}</span>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
