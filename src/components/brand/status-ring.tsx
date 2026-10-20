import { cn } from "@/lib/utils";

/**
 * The status ring — the logo as a measuring tool (Brand Guidelines p.31). The ring fills with
 * progress and the dot leads the movement; when the work is complete the ring closes into the
 * symbol itself. State is never shown by colour alone: pair the ring with its status text.
 */
export type RingState = "notStarted" | "inProgress" | "awaiting" | "late" | "paused" | "complete";

const R = 44.65; // ring path radius in a 100-unit box (ring thickness x = 10.7)
const X = 10.7;
const START = 107.5; // where the logo's ring begins, at the end of the 45° gap (maths degrees)
const SPAN = 315; // the logo ring's length; a full value draws the symbol
const GAP_CENTRE = 130;

const pt = (deg: number, r = R) => [50 + r * Math.cos((deg * Math.PI) / 180), 50 - r * Math.sin((deg * Math.PI) / 180)] as const;

function arc(from: number, sweep: number) {
  const [x1, y1] = pt(from);
  const [x2, y2] = pt(from - sweep);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${R} ${R} 0 ${sweep > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const COLOR: Record<RingState, string> = {
  notStarted: "var(--muted-foreground)",
  inProgress: "var(--primary)",
  awaiting: "var(--warning)",
  late: "var(--danger)",
  paused: "var(--danger)",
  complete: "var(--brand-violet)",
};

export function StatusRing({ state, value = 0, size = 16, label, className }: { state: RingState; value?: number; size?: number; label?: string; className?: string }) {
  const v = Math.min(1, Math.max(0, value));
  const color = COLOR[state];
  const sweep = state === "inProgress" || state === "awaiting" || state === "late" ? Math.max(v * SPAN, 0) : 0;
  const head = state === "complete" ? GAP_CENTRE : START - sweep;
  const [dx, dy] = pt(head);
  return (
    <svg viewBox="-6 -6 112 112" width={size} height={size} className={cn("shrink-0", className)} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ direction: "ltr" }}>
      {state === "complete" ? (
        <path d={arc(START, SPAN)} fill="none" stroke="var(--foreground)" strokeWidth={X} />
      ) : state === "paused" ? (
        <circle cx={50} cy={50} r={R} fill="none" stroke="var(--muted-foreground)" strokeWidth={X} strokeDasharray="9 7" />
      ) : (
        <>
          <circle cx={50} cy={50} r={R} fill="none" stroke="var(--chart-track)" strokeWidth={X} />
          {sweep > 0.5 && <path d={arc(START, sweep)} fill="none" stroke={color} strokeWidth={X} />}
        </>
      )}
      <circle cx={dx} cy={dy} r={X} fill={color} />
    </svg>
  );
}

