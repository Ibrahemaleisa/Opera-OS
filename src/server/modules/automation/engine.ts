import type { OutboxEvent, Prisma } from "@/generated/prisma/client";
import { systemContext } from "@/server/authz/context";
import { adminDb } from "@/server/db/admin";
import { withTenant, type Tx } from "@/server/db/tenant";
import { audit } from "@/server/modules/audit/audit";
import { notify } from "@/server/modules/notifications/notify";
import { nextTaskNumber } from "@/server/modules/tasks/numbering";
import { actionsSchema, conditionsSchema, matchesConditions, type AutomationAction } from "./rules";

const MAX_EVENT_ATTEMPTS = 5;

/**
 * Processes pending outbox events for one tenant. Each (rule, event) pair runs at most once:
 * AutomationExecution.idempotencyKey is unique, and completed executions are skipped on replay.
 */
export async function processOutbox(orgId: string, limit = 100): Promise<{ processed: number; executions: number }> {
  const events = await withTenant({ orgId }, (tx) =>
    tx.outboxEvent.findMany({ where: { processedAt: null, attempts: { lt: MAX_EVENT_ATTEMPTS } }, orderBy: { createdAt: "asc" }, take: limit }),
  );
  let executions = 0;
  for (const event of events) {
    try {
      executions += await processEvent(orgId, event);
      await withTenant({ orgId }, (tx) => tx.outboxEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), attempts: { increment: 1 } } }));
    } catch (err) {
      await withTenant({ orgId }, (tx) =>
        tx.outboxEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 }, lastError: (err as Error).message.slice(0, 1000) } }),
      );
    }
  }
  return { processed: events.length, executions };
}

async function processEvent(orgId: string, event: OutboxEvent): Promise<number> {
  const rules = await withTenant({ orgId }, (tx) => tx.automationRule.findMany({ where: { trigger: event.type, enabled: true } }));
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  let count = 0;
  for (const rule of rules) {
    const key = `${rule.id}:${event.id}`;
    const done = await withTenant({ orgId }, async (tx) => {
      const existing = await tx.automationExecution.findUnique({ where: { idempotencyKey: key } });
      if (existing && (existing.status === "SUCCEEDED" || existing.status === "SKIPPED")) return true;
      if (!existing) await tx.automationExecution.create({ data: { organizationId: orgId, ruleId: rule.id, eventId: event.id, idempotencyKey: key, status: "PENDING" } });
      return false;
    });
    if (done) continue;
    const conditions = conditionsSchema.safeParse(rule.conditions);
    if (conditions.success && !matchesConditions(conditions.data, payload)) {
      await withTenant({ orgId }, (tx) => tx.automationExecution.update({ where: { idempotencyKey: key }, data: { status: "SKIPPED", finishedAt: new Date() } }));
      continue;
    }
    const actions = actionsSchema.safeParse(rule.actions);
    try {
      if (!actions.success) throw new Error("Invalid rule actions");
      // Actions + execution status commit together: a crash mid-way replays the whole rule.
      const result = await withTenant({ orgId, userId: event.actorId }, async (tx) => {
        await tx.automationExecution.update({ where: { idempotencyKey: key }, data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } } });
        const results: unknown[] = [];
        for (const action of actions.data) results.push(await runAction(tx, orgId, event, payload, action));
        await tx.automationExecution.update({
          where: { idempotencyKey: key },
          data: { status: "SUCCEEDED", finishedAt: new Date(), result: results as Prisma.InputJsonValue },
        });
        return results;
      });
      count += result.length ? 1 : 0;
    } catch (err) {
      await withTenant({ orgId }, (tx) =>
        tx.automationExecution.update({ where: { idempotencyKey: key }, data: { status: "FAILED", error: (err as Error).message.slice(0, 1000), finishedAt: new Date() } }),
      );
      throw err;
    }
  }
  return count;
}

async function projectManagers(tx: Tx, projectId: unknown): Promise<string[]> {
  if (typeof projectId !== "string") return orgAdmins(tx);
  const pms = await tx.projectMember.findMany({ where: { projectId, role: "MANAGER" }, select: { userId: true } });
  return pms.length ? pms.map((p) => p.userId) : orgAdmins(tx);
}

async function orgAdmins(tx: Tx): Promise<string[]> {
  const admins = await tx.membership.findMany({ where: { status: "ACTIVE", role: { baseRole: { in: ["OWNER", "OPS_DIRECTOR"] } } }, select: { userId: true } });
  return admins.map((a) => a.userId);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

async function runAction(tx: Tx, orgId: string, event: OutboxEvent, p: Record<string, unknown>, action: AutomationAction): Promise<unknown> {
  switch (action.type) {
    case "notify": {
      const ids: string[] = [];
      for (const to of action.to) {
        if (to === "assignee" || to === "owner") ids.push(...[str(p.ownerId), str(p.agentId)].filter((x): x is string => !!x));
        if (to === "actor" && event.actorId) ids.push(event.actorId);
        if (to === "mentioned" && Array.isArray(p.mentions)) ids.push(...(p.mentions as string[]));
        if (to === "approver" && str(p.approverUserId)) ids.push(p.approverUserId as string);
        if (to === "requester" && str(p.requestedById)) ids.push(p.requestedById as string);
        if (to === "project_managers") ids.push(...(await projectManagers(tx, p.projectId)));
        if (to === "org_admins") ids.push(...(await orgAdmins(tx)));
      }
      const exclude = action.to.includes("actor") ? null : event.actorId;
      const n = await notify(tx, {
        orgId,
        userIds: ids,
        type: event.type,
        titleKey: action.titleKey,
        params: { title: str(p.title), code: str(p.code), count: typeof p.count === "number" ? p.count : null, name: str(p.name) },
        link: str(p.link) ?? undefined,
        entityType: str(p.entityType) ?? undefined,
        entityId: str(p.entityId) ?? undefined,
        excludeUserId: exclude,
      });
      return { notify: n };
    }
    case "create_task": {
      const projectId = str(p.projectId);
      if (!projectId) return { skipped: "no project" };
      const pm = action.assignTo === "project_manager" ? (await projectManagers(tx, projectId))[0] : action.assignTo === "actor" ? event.actorId : null;
      const number = await nextTaskNumber(tx, projectId);
      const task = await tx.task.create({
        data: {
          organizationId: orgId,
          projectId,
          workstreamId: str(p.workstreamId),
          number,
          title: `${action.titleKey === "auto.followUpDelivery" ? "متابعة توصيل" : "متابعة"}: ${str(p.title) ?? str(p.code) ?? ""}`.trim(),
          description: str(p.reason) ?? undefined,
          priority: action.priority,
          ownerId: pm ?? null,
          dueAt: new Date(Date.now() + action.dueInHours * 3600_000),
          tags: ["automation"],
          createdById: event.actorId ?? pm ?? "system",
        },
      });
      return { taskId: task.id };
    }
    case "escalate": {
      if (str(p.taskId)) await tx.task.updateMany({ where: { id: p.taskId as string, escalatedAt: null }, data: { escalatedAt: new Date() } });
      if (str(p.deliveryId)) await tx.delivery.updateMany({ where: { id: p.deliveryId as string, escalatedAt: null }, data: { escalatedAt: new Date() } });
      return { escalated: true };
    }
    case "reopen_entity": {
      const entityType = str(p.entityType);
      const entityId = str(p.entityId);
      if (entityType === "TASK" && entityId) {
        await tx.task.updateMany({ where: { id: entityId }, data: { status: "in_progress", statusCategory: "ACTIVE", completedAt: null } });
        // Dependents that were started on the assumption of approval go back to blocked.
        const deps = await tx.taskDependency.findMany({ where: { dependsOnId: entityId }, select: { taskId: true } });
        if (deps.length)
          await tx.task.updateMany({ where: { id: { in: deps.map((d) => d.taskId) }, statusCategory: { in: ["ACTIVE", "REVIEW"] } }, data: { statusCategory: "BLOCKED", status: "blocked", blockedReason: "approval_rejected" } });
        return { reopened: entityId, dependents: deps.length };
      }
      if (entityType === "DELIVERABLE" && entityId) {
        await tx.deliverable.updateMany({ where: { id: entityId }, data: { status: "IN_PROGRESS" } });
        return { reopened: entityId };
      }
      if (entityType === "DESIGN_REVISION" && entityId) return { reopened: entityId };
      return { skipped: true };
    }
    case "update_campaign_progress": {
      const campaignId = str(p.campaignId);
      if (!campaignId) return { skipped: true };
      const [total, done] = await Promise.all([
        tx.delivery.count({ where: { campaignId, status: { not: "CANCELLED" } } }),
        tx.delivery.count({ where: { campaignId, status: "DELIVERED" } }),
      ]);
      if (total > 0 && total === done) await tx.invitationCampaign.updateMany({ where: { id: campaignId, status: { not: "COMPLETED" } }, data: { status: "COMPLETED" } });
      else await tx.invitationCampaign.updateMany({ where: { id: campaignId, status: { in: ["DRAFT", "APPROVED"] } }, data: { status: "ACTIVE" } });
      return { total, done };
    }
    case "create_closeout_checklist": {
      const projectId = str(p.projectId);
      if (!projectId) return { skipped: true };
      const existing = await tx.task.findFirst({ where: { projectId, templateKey: "closeout" } });
      if (existing) return { existing: existing.id };
      const pm = (await projectManagers(tx, projectId))[0] ?? null;
      const number = await nextTaskNumber(tx, projectId);
      const task = await tx.task.create({
        data: {
          organizationId: orgId,
          projectId,
          number,
          templateKey: "closeout",
          title: "إقفال المشروع / Project closeout",
          priority: "HIGH",
          ownerId: pm,
          dueAt: new Date(Date.now() + 7 * 86400_000),
          tags: ["closeout", "automation"],
          createdById: event.actorId ?? pm ?? "system",
          checklists: {
            create: {
              organizationId: orgId,
              title: "قائمة الإقفال / Closeout checklist",
              items: {
                create: [
                  "تسليم جميع المخرجات النهائية / All deliverables handed over",
                  "اعتماد العميل النهائي / Final client sign-off",
                  "إقفال أوامر الشراء والمصروفات / Close POs and expenses",
                  "تقييم أداء الموردين / Rate vendor performance",
                  "تقرير ما بعد الفعالية / Post-event report",
                  "أرشفة الملفات وتطبيق سياسة الاحتفاظ بالبيانات / Archive files, apply data retention",
                ].map((label, i) => ({ organizationId: orgId, label, sortOrder: i })),
              },
            },
          },
        },
      });
      await audit(tx, systemContext(orgId), { action: "automation.closeout_created", entityType: "TASK", entityId: task.id, projectId });
      return { taskId: task.id };
    }
  }
}

/** Org ids with pending outbox rows (worker sweep). Uses the owner connection for discovery only. */
export async function orgsWithPendingOutbox(): Promise<string[]> {
  const rows = await adminDb().outboxEvent.findMany({
    where: { processedAt: null, attempts: { lt: MAX_EVENT_ATTEMPTS } },
    distinct: ["organizationId"],
    select: { organizationId: true },
    take: 500,
  });
  return rows.map((r) => r.organizationId);
}
