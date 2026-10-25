import { ChevronsUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "Someone above was pulled in" (UX note 4): ChevronsUp + "Escalated · level n" on warning-soft.
 * Never red fill, never pulsing; danger stays reserved for late and severity. Labels come from the
 * caller's dictionary (`m.notif.escalated`, `m.notif.escalatedLevel`), so it renders on server and client.
 */
export function EscalatedChip({ level, label, levelLabel, title, className }: { level?: number | null; label: string; levelLabel?: string; title?: string; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-warning-soft px-1.5 text-[11px] leading-none font-medium whitespace-nowrap text-warning", className)} title={title} data-testid="escalated-chip">
      <ChevronsUp className="size-3" aria-hidden />
      {label}
      {level && levelLabel ? <span className="ltr-nums tabular">· {levelLabel}</span> : null}
    </span>
  );
}
