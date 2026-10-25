import Link from "next/link";
import { GapMark } from "@/components/brand/gap-mark";
import { interpolate, type Messages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { HealthReason, ProjectHealth } from "@/server/modules/projects/health";

type M = Messages;
type Level = "good" | "watch" | "critical";

const LEVEL_TONE = { good: "text-success", watch: "text-warning", critical: "text-danger" } as const;
const LEVEL_DOT = { good: "bg-success", watch: "bg-warning", critical: "bg-danger" } as const;

export function levelWord(level: Level, m: M) {
  return level === "good" ? m.projects.healthGood : level === "watch" ? m.projects.healthWatch : m.projects.healthCritical;
}

/** Health as words first, the number second: "Critical · 17". */
export function HealthWord({ health, m, className }: { health: { score: number; level: Level }; m: M; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap", LEVEL_TONE[health.level], className)}>
      <span className={cn("size-1.5 rounded-full", LEVEL_DOT[health.level])} aria-hidden />
      {levelWord(health.level, m)}
      <span className="tabular font-normal text-muted-foreground">· {health.score}</span>
    </span>
  );
}

/** Level word + the reason that costs most. Accepts v1 results (no reasons) during the switch-over. */
export function HealthCell({ health, m, financeVisible }: { health: { score: number; level: Level; reasons?: HealthReason[] }; m: M; financeVisible: boolean }) {
  const top = health.reasons?.find((r) => r.points > 0);
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <HealthWord health={health} m={m} />
      {top && <span className="truncate text-[11px] text-muted-foreground">{reasonText(top, m, financeVisible)}</span>}
    </span>
  );
}

/** One reason in the user's language; finance detail is withheld from viewers without finance scope. */
export function reasonText(r: HealthReason, m: M, financeVisible: boolean) {
  if (r.finance && !financeVisible) return m.ops.health.reason.financeHidden;
  return interpolate(m.ops.health.reason[r.key], { n: r.count });
}

/** The top reason that actually costs points (client delay is shown but never leads). */
export function topReason(h: ProjectHealth) {
  return h.reasons.find((r) => r.points > 0) ?? null;
}

const REASON_LINK: Partial<Record<HealthReason["key"], (b: string) => string>> = {
  schedule: (b) => `${b}/tasks?view=timeline`,
  overdue: (b) => `${b}/tasks?overdue=1`,
  unowned: (b) => `${b}/tasks?view=workload`,
  approvalsOverdue: (b) => `${b}/approvals`,
  clientDelay: (b) => `${b}/approvals`,
  blocked: (b) => `${b}/tasks?category=BLOCKED`,
  overContract: (b) => `${b}/finance`,
  overPlan: (b) => `${b}/finance`,
  readiness: (b) => `${b}/events`,
  incidents: (b) => `${b}/events`,
};

/** "What is in the way", worst first, each reason a doorway to the records behind it. */
export function ReasonList({ health, m, financeVisible, projectHref, className }: { health: ProjectHealth; m: M; financeVisible: boolean; projectHref?: string; className?: string }) {
  if (!health.reasons.length) return <p className={cn("py-2 text-sm text-muted-foreground", className)}>{m.ops.health.nothing}</p>;
  return (
    <ul className={cn("divide-y", className)}>
      {health.reasons.map((r) => {
        const text = reasonText(r, m, financeVisible);
        const href = projectHref && REASON_LINK[r.key] && !(r.finance && !financeVisible) ? REASON_LINK[r.key]!(projectHref) : null;
        return (
          <li key={r.key} className="flex min-h-10 items-center gap-3 py-2 text-[13px]">
            {r.key === "unowned" ? <GapMark size={14} /> : <span className={cn("size-1.5 shrink-0 rounded-full", r.points === 0 ? "bg-muted-foreground/50" : r.blocker || r.points >= 15 ? "bg-danger" : "bg-warning")} aria-hidden />}
            <span className="min-w-0 flex-1">{href ? <Link href={href} className="hover:text-primary hover:underline">{text}</Link> : text}</span>
            {r.points > 0 && <span className="ltr-nums shrink-0 text-xs text-muted-foreground">{interpolate(m.ops.health.points, { n: r.points })}</span>}
          </li>
        );
      })}
    </ul>
  );
}
