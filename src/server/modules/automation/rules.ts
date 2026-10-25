import { z } from "zod";

export const conditionValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.object({ in: z.array(z.union([z.string(), z.number()])) }),
  z.object({ gte: z.number() }),
  z.object({ lte: z.number() }),
]);

export const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notify"),
    to: z.array(z.enum(["assignee", "owner", "project_managers", "actor", "mentioned", "approver", "requester", "org_admins"])),
    titleKey: z.string(),
  }),
  z.object({ type: z.literal("create_task"), titleKey: z.string(), assignTo: z.enum(["project_manager", "actor", "none"]).default("project_manager"), dueInHours: z.number().default(24), priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("HIGH") }),
  z.object({ type: z.literal("escalate") }),
  z.object({ type: z.literal("reopen_entity") }),
  z.object({ type: z.literal("update_campaign_progress") }),
  z.object({ type: z.literal("create_closeout_checklist") }),
]);

export type AutomationAction = z.infer<typeof actionSchema>;
export const actionsSchema = z.array(actionSchema);
export const conditionsSchema = z.record(z.string(), conditionValue);

export interface RuleDef {
  key: string;
  name: string;
  nameEn: string;
  trigger: string;
  conditions?: Record<string, z.infer<typeof conditionValue>>;
  actions: AutomationAction[];
}

/**
 * Default rules that Milestone 2 replaced. Existing organisations still have the rows; the engine never
 * runs them and the automation settings hide them:
 *  - `task-overdue-escalate` repeated a notice to the owner and the PMs every day; the scheduler's
 *    tiered ladder (BUSINESS_RULES §3.4) replaces it, each tier once per occurrence;
 *  - `campaign-approval-notify` told every admin about a campaign approval on top of the approver
 *    notice; `approval.requested` covers it, so nobody gets two notices for one request (§3.2 NT rule 1).
 */
export const RETIRED_RULE_KEYS: ReadonlySet<string> = new Set(["task-overdue-escalate", "campaign-approval-notify"]);

/** Default rules installed (enabled) in every organization. Editable per org. */
export const DEFAULT_RULES: RuleDef[] = [
  { key: "task-assigned-notify", name: "إشعار عند إسناد مهمة", nameEn: "Notify on task assignment", trigger: "task.assigned", actions: [{ type: "notify", to: ["assignee"], titleKey: "notif.taskAssigned" }] },
  { key: "task-due-soon", name: "تذكير قبل موعد الاستحقاق", nameEn: "Reminder before deadline", trigger: "task.due_soon", actions: [{ type: "notify", to: ["assignee"], titleKey: "notif.taskDueSoon" }] },
  { key: "delivery-failed-followup", name: "متابعة التوصيل الفاشل", nameEn: "Follow up failed delivery", trigger: "delivery.failed", actions: [{ type: "create_task", titleKey: "auto.followUpDelivery", assignTo: "project_manager", dueInHours: 24, priority: "HIGH" }, { type: "notify", to: ["project_managers"], titleKey: "notif.deliveryFailed" }] },
  { key: "delivery-completed-progress", name: "تحديث تقدم الحملة عند التسليم", nameEn: "Update campaign progress on delivery", trigger: "delivery.delivered", actions: [{ type: "update_campaign_progress" }] },
  { key: "delivery-assigned-notify", name: "إشعار المندوب بالإسناد", nameEn: "Notify agent on assignment", trigger: "delivery.assigned", actions: [{ type: "notify", to: ["assignee"], titleKey: "notif.deliveriesAssigned" }] },
  { key: "approval-requested-notify", name: "إشعار المعتمد بطلب اعتماد", nameEn: "Notify approver", trigger: "approval.requested", actions: [{ type: "notify", to: ["approver"], titleKey: "notif.approvalRequested" }] },
  { key: "approval-rejected-reopen", name: "إعادة فتح العمل عند الرفض", nameEn: "Reopen work on rejection", trigger: "approval.rejected", actions: [{ type: "reopen_entity" }, { type: "notify", to: ["requester"], titleKey: "notif.approvalRejected" }] },
  { key: "approval-decided-notify", name: "إشعار مقدم الطلب بالقرار", nameEn: "Notify requester of decision", trigger: "approval.decided", conditions: { status: "APPROVED" }, actions: [{ type: "notify", to: ["requester"], titleKey: "notif.approvalApproved" }] },
  { key: "milestone-blocked-notify", name: "تنبيه مدير المشروع عند تعثر مرحلة", nameEn: "Alert PM on blocked milestone", trigger: "milestone.blocked", actions: [{ type: "notify", to: ["project_managers"], titleKey: "notif.milestoneBlocked" }] },
  { key: "import-completed-notify", name: "إشعار عند اكتمال الاستيراد", nameEn: "Notify uploader on import completion", trigger: "import.completed", actions: [{ type: "notify", to: ["actor"], titleKey: "notif.importCompleted" }] },
  { key: "import-failed-notify", name: "إشعار عند فشل الاستيراد", nameEn: "Notify uploader on import failure", trigger: "import.failed", actions: [{ type: "notify", to: ["actor"], titleKey: "notif.importFailed" }] },
  { key: "event-approaching-readiness", name: "فحص الجاهزية قبل الفعالية", nameEn: "Readiness check before event", trigger: "event.approaching", actions: [{ type: "notify", to: ["project_managers"], titleKey: "notif.eventApproaching" }] },
  { key: "project-completed-closeout", name: "إنشاء قائمة الإقفال عند اكتمال المشروع", nameEn: "Generate closeout checklist", trigger: "project.completed", actions: [{ type: "create_closeout_checklist" }] },
  { key: "mention-notify", name: "إشعار عند الإشارة", nameEn: "Notify on mention", trigger: "comment.mentioned", actions: [{ type: "notify", to: ["mentioned"], titleKey: "notif.mentioned" }] },
  { key: "incident-reported-notify", name: "تنبيه عند تسجيل بلاغ", nameEn: "Alert on incident", trigger: "incident.reported", conditions: { severity: { in: ["HIGH", "CRITICAL"] } }, actions: [{ type: "notify", to: ["project_managers", "org_admins"], titleKey: "notif.incidentReported" }] },
];

export function matchesConditions(conditions: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(conditions)) {
    const actual = payload[field];
    if (expected && typeof expected === "object") {
      if ("in" in expected && Array.isArray(expected.in)) {
        if (!expected.in.includes(actual as never)) return false;
      } else if ("gte" in expected) {
        if (typeof actual !== "number" || actual < (expected.gte as number)) return false;
      } else if ("lte" in expected) {
        if (typeof actual !== "number" || actual > (expected.lte as number)) return false;
      }
    } else if (actual !== expected) return false;
  }
  return true;
}
