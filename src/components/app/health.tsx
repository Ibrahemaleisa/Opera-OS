"use client";

import { reasonText } from "@/components/operations/health";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { HealthReason } from "@/server/modules/projects/health";

export function HealthPill({ health, compact, financeVisible = false }: { health: { score: number; level: "good" | "watch" | "critical"; reasons?: HealthReason[] }; compact?: boolean; financeVisible?: boolean }) {
  const { m } = useI18n();
  const label = health.level === "good" ? m.projects.healthGood : health.level === "watch" ? m.projects.healthWatch : m.projects.healthCritical;
  const tone = health.level === "good" ? "text-success bg-success-soft" : health.level === "watch" ? "text-warning bg-warning-soft" : "text-danger bg-danger-soft";
  // the same localized reasons as the overview, worst first
  const tip = health.reasons?.filter((r) => r.points > 0).map((r) => `${reasonText(r, m, financeVisible)} (−${r.points})`).join(" · ") || undefined;
  return (
    <span title={tip} className={cn("tabular inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap", tone)}>
      {health.score}
      {!compact && <span className="font-medium">{label}</span>}
    </span>
  );
}
