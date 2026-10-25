import type { OutboxEvent, Prisma } from "@/generated/prisma/client";
import { systemContext } from "@/server/authz/context";
import { adminDb } from "@/server/db/admin";
import { withTenant, type Tx } from "@/server/db/tenant";
import { audit } from "@/server/modules/audit/audit";
import { notify } from "@/server/modules/notifications/notify";
import { nextTaskNumber } from "@/server/modules/tasks/numbering";
import { DEFAULT_STATUSES, type StatusDef } from "@/server/modules/templates/definition";
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
      // ON CONFLICT DO NOTHING: a concurrent drain may have created it a moment ago
      if (!existing) await tx.automationExecution.createMany({ data: [{ organizationId: orgId, ruleId: rule.id, eventId: event.id, idempotencyKey: key, status: "PENDING" }], skipDuplicates: true });
      return false;
    });
    if (done) continue;
    const conditions = conditionsSchema.safeParse(rule.conditions);
    if (conditions.success && !matchesConditions(conditions.data, payload)) {
      await withTenant({ orgId }, (tx) => tx.automationExecution.updateMany({ where: { idempotencyKey: key, status: { in: ["PENDING", "FAILED"] } }, data: { status: "SKIPPED", finishedAt: new Date() } }));
      continue;
    }
    const actions = actionsSchema.safeParse(rule.actions);
    try {
      if (!actions.success) throw new Error("Invalid rule actions");
      // Claim + actions + final status commit together: a crash mid-way rolls back to PENDING and is
      // replayed; a concurrent drain blocks on the row lock, then finds it SUCCEEDED and runs nothing.
      const result = await withTenant({ orgId, userId: event.actorId }, async (tx) => {
        const claim = await tx.automationExecution.updateMany({ where: { idempotencyKey: key, status: { in: ["PENDING", "FAILED"] } }, data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } } });
        if (!claim.count) return null;
        const results: unknown[] = [];
        for (const action of actions.data) results.push(await runAction(tx, orgId, event, payload, action));
        await tx.automationExecution.update({
          where: { idempotencyKey: key },
          data: { status: "SUCCEEDED", finishedAt: new Date(), result: results as Prisma.InputJsonValue },
        });
        return results;
      });
      count += result?.length ? 1 : 0;
    } catch (err) {
      await withTenant({ orgId }, (tx) =>
        tx.automationExecution.update({ where: { idempotencyKey: key }, data: { status: "FAILED", error: (err as Error).message.slice(0, 1000), finishedAt: new Date() } }),
      );
      throw err;
    }
  }
  return count;
}

/** Active project managers; when none is active (left / suspended), the org's owners and ops directors. */
async function projectManagers(tx: Tx, orgId: string, projectId: unknown): Promise<string[]> {
  if (typeof projectId !== "string") return orgAdmins(tx, orgId);
  const pms = await tx.projectMember.findMany({ where: { projectId, role: "MANAGER" }, select: { userId: true } });
  const active = await activeOnly(tx, orgId, pms.map((p) => p.userId));
  return active.length ? active : orgAdmins(tx, orgId);
}

async function orgAdmins(tx: Tx, orgId: string): Promise<string[]> {
  const admins = await tx.membership.findMany({ where: { organizationId: orgId, status: "ACTIVE", role: { baseRole: { in: ["OWNER", "OPS_DIRECTOR"] } } }, select: { userId: true } });
  return admins.map((a) => a.userId);
}

/** Drops users without an ACTIVE membership in this org (suspended / revoked people get no work or alerts). */
async function activeOnly(tx: Tx, orgId: string, userIds: (string | null | undefined)[]): Promise<string[]> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x && x !== "system"))];
  if (!ids.length) return [];
  const rows = await tx.membership.findMany({ where: { organizationId: orgId, userId: { in: ids }, status: "ACTIVE" }, select: { userId: true } });
  const ok = new Set(rows.map((r) => r.userId));
  return ids.filter((id) => ok.has(id));
}

function statusesOf(ws: { statuses: unknown } | null | undefined): StatusDef[] {
  const s = ws?.statuses as StatusDef[] | undefined;
  return Array.isArray(s) && s.length ? s : DEFAULT_STATUSES;
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
        if (to === "approver") {
          if (Array.isArray(p.approverUserIds)) ids.push(...(p.approverUserIds as string[]));
          else if (str(p.approverUserId)) ids.push(p.approverUserId as string);
        }
        if (to === "requester" && str(p.requestedById)) ids.push(p.requestedById as string);
        if (to === "project_managers") ids.push(...(await projectManagers(tx, orgId, p.projectId)));
        if (to === "org_admins") ids.push(...(await orgAdmins(tx, orgId)));
      }
      const exclude = action.to.includes("actor") ? null : event.actorId;
      let recipients = await activeOnly(tx, orgId, ids);
      // everyone addressed by an actionable alert has left: it still has to reach someone who can act
      const actionable = action.to.some((t) => ["assignee", "owner", "project_managers", "approver"].includes(t));
      if (actionable && ids.length && !recipients.filter((u) => u !== exclude).length) recipients = await projectManagers(tx, orgId, p.projectId);
      const n = await notify(tx, {
        orgId,
        userIds: recipients,
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
      const pm = action.assignTo === "project_manager" ? (await projectManagers(tx, orgId, projectId))[0] : action.assignTo === "actor" ? (await activeOnly(tx, orgId, [event.actorId]))[0] ?? null : null;
      const number = await nextTaskNumber(tx, projectId);
      const task = await tx.task.create({
        data: {
          organizationId: orgId,
          projectId,
          workstreamId: str(p.workstreamId),
          number,
          // a delivery follow-up names the card, not the VIP: task titles are visible to every project member
          title: action.titleKey === "auto.followUpDelivery" ? `متابعة توصيل: ${str(p.code) ?? ""}`.trim() : `متابعة: ${str(p.title) ?? str(p.code) ?? ""}`.trim(),
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
        // status keys come from each task's own workstream workflow; version bump makes stale edits conflict
        const sys = systemContext(orgId);
        const task = await tx.task.findUnique({ where: { id: entityId }, include: { workstream: true } });
        const active = statusesOf(task?.workstream).find((s) => s.category === "ACTIVE");
        let reopened = 0;
        if (task && active && ["REVIEW", "DONE"].includes(task.statusCategory)) {
          reopened = (await tx.task.updateMany({ where: { id: task.id, statusCategory: task.statusCategory }, data: { status: active.key, statusCategory: "ACTIVE", completedAt: null, version: { increment: 1 } } })).count;
          if (reopened) await audit(tx, sys, { action: "automation.task_reopened", entityType: "TASK", entityId: task.id, projectId: task.projectId, before: { status: task.status }, after: { status: active.key }, summary: "approval rejected" });
        }
        // Dependents that were started on the assumption of approval go back to blocked.
        const deps = await tx.taskDependency.findMany({ where: { dependsOnId: entityId, task: { statusCategory: { in: ["ACTIVE", "REVIEW"] } } }, include: { task: { include: { workstream: true } } } });
        let blocked = 0;
        for (const d of deps) {
          const b = statusesOf(d.task.workstream).find((s) => s.category === "BLOCKED");
          if (!b) continue;
          const r = await tx.task.updateMany({ where: { id: d.taskId, statusCategory: d.task.statusCategory }, data: { statusCategory: "BLOCKED", status: b.key, blockedReason: "approval_rejected", version: { increment: 1 } } });
          if (r.count) {
            blocked++;
            await audit(tx, sys, { action: "automation.task_blocked", entityType: "TASK", entityId: d.taskId, projectId: d.task.projectId, before: { status: d.task.status }, after: { status: b.key }, summary: "upstream approval rejected" });
          }
        }
        return { reopened: reopened ? entityId : null, dependents: blocked };
      }
      if (entityType === "DELIVERABLE" && entityId) {
        const r = await tx.deliverable.updateMany({ where: { id: entityId, status: "REJECTED" }, data: { status: "IN_PROGRESS" } });
        if (r.count) await audit(tx, systemContext(orgId), { action: "automation.deliverable_reopened", entityType: "DELIVERABLE", entityId, projectId: str(p.projectId), summary: "approval rejected" });
        return { reopened: r.count ? entityId : null };
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
      const pm = (await projectManagers(tx, orgId, projectId))[0] ?? null;
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
