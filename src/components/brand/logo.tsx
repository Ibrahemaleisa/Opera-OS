import { cn } from "@/lib/utils";
import { SYMBOL, WORDMARK_EN } from "./logo-paths";

/**
 * Brand marks. Never stretched, rotated, recoloured or mirrored: the gap stays at 11 o'clock in
 * RTL too. Ink on light grounds, Mist on dark; the dot is the only colour — Violet, or Lilac on a
 * Violet ground so it never disappears.
 */
export type LogoTone = "dark" | "light" | "on-violet";

const COLORS: Record<LogoTone, { mark: string; dot: string }> = {
  dark: { mark: "var(--ink)", dot: "var(--brand-violet)" },
  light: { mark: "var(--mist)", dot: "var(--brand-violet)" },
  "on-violet": { mark: "var(--mist)", dot: "var(--lilac)" },
};

/** The ring + dot. Minimum size 16px. */
export function OperaSymbol({ tone = "dark", className, title }: { tone?: LogoTone; className?: string; title?: string }) {
  const c = COLORS[tone];
  return (
    <svg viewBox={SYMBOL.viewBox} className={cn("block shrink-0", className)} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} style={{ direction: "ltr" }}>
      <path d={SYMBOL.ring} fill="none" stroke={c.mark} strokeWidth={SYMBOL.stroke} strokeLinecap="butt" />
      <circle cx={SYMBOL.dot.cx} cy={SYMBOL.dot.cy} r={SYMBOL.dot.r} fill={c.dot} />
    </svg>
  );
}

/** The Latin horizontal wordmark — the default signature for the product in both locales. Minimum width 80px. */
export function OperaWordmark({ tone = "dark", className, title = "Opera" }: { tone?: LogoTone; className?: string; title?: string }) {
  const c = COLORS[tone];
  return (
    <svg viewBox={WORDMARK_EN.viewBox} className={cn("block h-6 w-auto shrink-0", className)} role="img" aria-label={title} style={{ direction: "ltr" }}>
      <path d={WORDMARK_EN.ring} fill="none" stroke={c.mark} strokeWidth={WORDMARK_EN.stroke} strokeLinecap="butt" />
      <circle cx={WORDMARK_EN.dot.cx} cy={WORDMARK_EN.dot.cy} r={WORDMARK_EN.dot.r} fill={c.dot} />
      <path d={WORDMARK_EN.text} fill={c.mark} />
    </svg>
  );
}
