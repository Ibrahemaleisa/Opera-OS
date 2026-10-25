import { cn } from "@/lib/utils";

/**
 * The gap mark — the symbol's ring without its dot: "a required piece is missing" (no owner,
 * no date, no checklist). Drawn with the logo's 45° gap at 11 o'clock and never mirrored.
 * Always paired with words; it is never used for "late" (late is the danger tone).
 */
const R = 44.65;
const X = 10.7;
const START = 107.5;
const SPAN = 315;
const pt = (deg: number) => [50 + R * Math.cos((deg * Math.PI) / 180), 50 - R * Math.sin((deg * Math.PI) / 180)] as const;
const [x1, y1] = pt(START);
const [x2, y2] = pt(START - SPAN);
const RING = `M${x1.toFixed(2)} ${y1.toFixed(2)}A${R} ${R} 0 1 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;

export function GapMark({ size = 14, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <svg viewBox="-6 -6 112 112" width={size} height={size} className={cn("shrink-0 text-warning", className)} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ direction: "ltr" }}>
      <path d={RING} fill="none" stroke="currentColor" strokeWidth={X * 1.2} strokeLinecap="butt" />
    </svg>
  );
}

/** The dot — "here and now": today on a time line, a live item. Pulses only when motion is allowed. */
export function NowDot({ live = false, className }: { live?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2.5 shrink-0", className)} aria-hidden>
      {live && <span className="absolute inset-0 rounded-full bg-primary/40 motion-safe:animate-ping" />}
      <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
    </span>
  );
}
