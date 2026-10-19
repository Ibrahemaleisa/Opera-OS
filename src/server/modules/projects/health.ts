export interface HealthInput {
  totalTasks: number;
  doneTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  openHighRisks: number;
  blockedMilestones: number;
  overdueMilestones: number;
  /** 0..1 elapsed share of schedule (start → deadline) */
  elapsed: number | null;
  /** actual / planned budget, null if unknown */
  budgetRatio: number | null;
}

/**
 * Health score 0–100 computed from live records. Transparent weighting:
 * overdue work, blocked work, schedule slip (elapsed vs. done), high risks,
 * blocked/overdue milestones and budget overrun each subtract points.
 */
export function computeHealth(h: HealthInput): { score: number; level: "good" | "watch" | "critical"; factors: Record<string, number> } {
  const factors: Record<string, number> = {};
  if (h.totalTasks > 0) {
    factors.overdue = Math.min(30, Math.round((h.overdueTasks / h.totalTasks) * 60));
    factors.blocked = Math.min(15, h.blockedTasks * 3);
    if (h.elapsed !== null) {
      const progress = h.doneTasks / h.totalTasks;
      const slip = Math.max(0, h.elapsed - progress);
      factors.schedule = Math.min(20, Math.round(slip * 40));
    }
  }
  factors.risks = Math.min(15, h.openHighRisks * 5);
  factors.milestones = Math.min(15, h.blockedMilestones * 5 + h.overdueMilestones * 4);
  if (h.budgetRatio !== null && h.budgetRatio > 1) factors.budget = Math.min(15, Math.round((h.budgetRatio - 1) * 50));
  const score = Math.max(0, 100 - Object.values(factors).reduce((a, b) => a + b, 0));
  return { score, level: score >= 75 ? "good" : score >= 50 ? "watch" : "critical", factors };
}
