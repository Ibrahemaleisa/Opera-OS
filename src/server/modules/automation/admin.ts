import type { ServiceContext } from "@/server/authz/context";
import { assertCan } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";
import { NotFoundError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { RETIRED_RULE_KEYS } from "./rules";
import { HEARTBEAT_RULE_KEY } from "./scheduler";

/** Rules with execution statistics computed from the execution log (last 30 days). */
export async function listAutomation(ctx: ServiceContext, now = new Date()) {
  assertCan(ctx, "automation.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const since = new Date(now.getTime() - 30 * 86400_000);
    const [rules, stats, recent, backlog] = await Promise.all([
      // retired defaults and the scheduler heartbeat are internal rows, not rules an admin can act on
      tx.automationRule.findMany({ where: { key: { notIn: [...RETIRED_RULE_KEYS, HEARTBEAT_RULE_KEY] } }, orderBy: [{ isSystem: "desc" }, { name: "asc" }] }),
      tx.automationExecution.groupBy({ by: ["ruleId", "status"], where: { createdAt: { gte: since } }, _count: true }),
      tx.automationExecution.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { rule: { select: { name: true, nameEn: true } } } }),
      tx.outboxEvent.count({ where: { processedAt: null } }),
    ]);
    return {
      backlog,
      rules: rules.map((r) => {
        const s = stats.filter((x) => x.ruleId === r.id);
        const n = (st: string) => s.find((x) => x.status === st)?._count ?? 0;
        return { ...r, stats: { succeeded: n("SUCCEEDED"), failed: n("FAILED"), skipped: n("SKIPPED") } };
      }),
      recent: recent.map((e) => ({ id: e.id, rule: (ctx.locale === "en" && e.rule.nameEn) || e.rule.name, status: e.status, attempts: e.attempts, error: e.error, createdAt: e.createdAt, finishedAt: e.finishedAt })),
    };
  });
}

export async function setRuleEnabled(ctx: ServiceContext, input: { id: string; enabled: boolean }) {
  assertCan(ctx, "automation.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const r = await tx.automationRule.findUnique({ where: { id: input.id } });
    if (!r || RETIRED_RULE_KEYS.has(r.key) || r.key === HEARTBEAT_RULE_KEY) throw new NotFoundError();
    await tx.automationRule.update({ where: { id: r.id }, data: { enabled: input.enabled } });
    await audit(tx, ctx, { action: input.enabled ? "automation.enable" : "automation.disable", entityType: "AUTOMATION_RULE", entityId: r.id, summary: r.name });
    return null;
  });
}
