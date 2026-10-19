"use client";

import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export function HealthPill({ health, compact }: { health: { score: number; level: "good" | "watch" | "critical"; factors?: Record<string, number> }; compact?: boolean }) {
  const { m } = useI18n();
  const label = health.level === "good" ? m.projects.healthGood : health.level === "watch" ? m.projects.healthWatch : m.projects.healthCritical;
  const tone = health.level === "good" ? "text-success bg-success-soft" : health.level === "watch" ? "text-warning bg-warning-soft" : "text-danger bg-danger-soft";
  const tip = health.factors ? Object.entries(health.factors).filter(([, v]) => v > 0).map(([k, v]) => `${k}: -${v}`).join(" · ") : undefined;
  return (
    <span title={tip} className={cn("tabular inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-semibold", tone)}>
      {health.score}
      {!compact && <span className="font-medium">{label}</span>}
    </span>
  );
}
