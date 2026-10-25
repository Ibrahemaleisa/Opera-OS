/**
 * Notification type registry (BUSINESS_RULES.md §3.2). One entry per notice type: its default message
 * key, whether the user may tune it, and the e-mail policy. `notify()` decides the e-mail channel from
 * this table; callers never send e-mail themselves.
 *
 * E-mail policy:
 *  - "mandatory": in-app AND e-mail are sent and cannot be switched off (M in the matrix);
 *  - "opt_on":   e-mail is optional, on unless the user switched it off;
 *  - "opt_off":  e-mail is optional, off unless the user switched it on;
 *  - "digest":   no immediate e-mail; listed in the daily digest only;
 *  - "none":     in-app only.
 */
export type EmailPolicy = "mandatory" | "opt_on" | "opt_off" | "digest" | "none";
export type NotificationPriority = "NORMAL" | "HIGH" | "CRITICAL";
export type Audience = "staff" | "external" | "both";

export interface NotificationTypeDef {
  type: string;
  /** default i18n message key (under `notif.*` or another dictionary) used for labels and e-mail */
  key: string;
  email: EmailPolicy;
  /** shown in the preference table (mandatory types are shown locked) */
  tunable: boolean;
  audience: Audience;
  /** the e-mail rule applies only at or above this priority (incidents: HIGH/CRITICAL only) */
  emailMinPriority?: NotificationPriority;
}

const T = (type: string, key: string, email: EmailPolicy, opts: Partial<Pick<NotificationTypeDef, "tunable" | "audience" | "emailMinPriority">> = {}): NotificationTypeDef => ({
  type,
  key,
  email,
  tunable: opts.tunable ?? true,
  audience: opts.audience ?? "staff",
  emailMinPriority: opts.emailMinPriority,
});

/** Every type Opera emits. Unknown types fall back to in-app only, tunable, no e-mail. */
export const NOTIFICATION_TYPES: Record<string, NotificationTypeDef> = Object.fromEntries(
  [
    // approvals (§3.2, §3.4)
    T("approval.requested", "notif.approvalRequested", "mandatory", { audience: "both" }),
    T("approval.reminder", "notif.approvalReminder", "mandatory", { audience: "both" }),
    T("approval.overdue", "notif.approvalOverdue", "mandatory", { audience: "both" }),
    T("approval.escalated", "notif.approvalEscalated", "mandatory"),
    T("approval.decided", "notif.approvalApproved", "opt_on"),
    T("approval.rejected", "notif.approvalRejected", "opt_on"),
    T("approval.cancelled", "tasks.approvalNotices.cancelled", "opt_off"),
    T("approval.withdrawn", "notif.types.approvalWithdrawn", "opt_off"),
    T("approval.superseded", "tasks.approvalNotices.superseded", "opt_off"),
    T("approval.reassigned", "notif.types.approvalReassigned", "opt_off"),
    T("approval.self_approved", "notif.types.selfApproved", "mandatory"),
    T("exception.self_approval", "notif.types.selfApproved", "mandatory"),
    T("approval.exception_enabled", "notif.types.exceptionEnabled", "mandatory"),
    // tasks
    T("task.assigned", "notif.taskAssigned", "opt_on"),
    T("task.due_soon", "notif.taskDueSoon", "digest"),
    T("task.overdue", "notif.taskOverdue", "opt_on"),
    T("task.escalated", "notif.taskEscalated", "mandatory"),
    T("task.unowned_due", "notif.taskUnownedDue", "opt_on"),
    T("comment.mentioned", "notif.mentioned", "digest"),
    // the daily summary e-mail (§3.2 NT rule 2): e-mail only, on by default
    T("digest.daily", "notif.types.digestDaily", "opt_on"),
    T("milestone.blocked", "notif.milestoneBlocked", "none"),
    // incidents
    T("incident.reported", "notif.incidentReported", "mandatory", { emailMinPriority: "HIGH" }),
    T("incident.escalated", "notif.incidentEscalated", "mandatory"),
    T("incident.assigned", "notif.types.incidentAssigned", "mandatory", { emailMinPriority: "HIGH" }),
    // deliveries and campaigns
    T("delivery.assigned", "notif.deliveriesAssigned", "none", { audience: "both" }),
    T("delivery.failed", "notif.deliveryFailed", "opt_off"),
    T("delivery.deadline_risk", "notif.types.deliveryDeadlineRisk", "mandatory"),
    T("delivery.recalled", "notif.types.deliveryRecalled", "mandatory", { audience: "both" }),
    T("campaign.stalled", "notif.types.campaignStalled", "mandatory"),
    T("campaign.late", "notif.types.campaignLate", "mandatory"),
    T("campaign.dispatch_stalled", "notif.types.campaignStalled", "mandatory"),
    T("campaign.held_late", "notif.types.campaignLate", "mandatory"),
    T("import.completed", "notif.importCompleted", "opt_off"),
    T("import.failed", "notif.importFailed", "opt_on"),
    T("import.stalled", "notif.types.importStalled", "opt_on"),
    // vendors
    T("workorder.not_accepted", "notif.workOrderNotAccepted", "mandatory", { audience: "both" }),
    T("workorder.overdue", "notif.workOrderOverdue", "mandatory", { audience: "both" }),
    T("workorder.escalated", "notif.workOrderEscalated", "mandatory"),
    T("workorder.delivered", "notif.types.workOrderDelivered", "opt_on"),
    T("workorder.cancelled", "notif.types.workOrderCancelled", "opt_on", { audience: "both" }),
    // events
    T("event.approaching", "notif.eventApproaching", "opt_on"),
    T("shift.cancelled", "notif.types.shiftCancelled", "opt_on"),
    // projects (§1.7)
    T("project.status_changed", "notif.types.projectStatusChanged", "none"),
    T("project.completed", "notif.types.projectStatusChanged", "none"),
    T("project.cancelled", "notif.types.projectCancelled", "opt_on", { audience: "both" }),
    T("project.closed", "notif.types.projectClosed", "none"),
    T("project.reopened", "notif.types.projectReopened", "none"),
    // people (§2.3)
    T("handover.assigned", "notif.types.handoverReceived", "mandatory"),
    T("handover.received", "notif.types.handoverReceived", "mandatory"),
    T("handover.unowned", "notif.types.handoverUnowned", "opt_on"),
    T("member.departed", "notif.types.memberDeparted", "opt_on"),
    T("security.mfa_reset", "notif.mfaResetByAdmin", "none", { tunable: false }),
    // client portal
    T("change_request.created", "notif.changeRequest", "opt_on"),
    T("change_request.responded", "notif.changeRequestResponded", "opt_on", { audience: "external" }),
    T("campaign.approval_requested", "notif.campaignApproval", "none", { tunable: false }),
  ].map((d) => [d.type, d]),
);

const FALLBACK: Omit<NotificationTypeDef, "type" | "key"> = { email: "none", tunable: true, audience: "staff" };

export function typeDef(type: string): NotificationTypeDef {
  return NOTIFICATION_TYPES[type] ?? { type, key: `notif.${type}`, ...FALLBACK };
}

/** Mandatory types: in-app and e-mail can't be switched off (preference UI shows them locked). */
export function isMandatoryType(type: string): boolean {
  const d = typeDef(type);
  // priority-dependent types (incidents) are mandatory only for urgent notices, which notify() forces anyway
  return d.email === "mandatory" && !d.emailMinPriority;
}

const PRIORITY_RANK: Record<NotificationPriority, number> = { NORMAL: 0, HIGH: 1, CRITICAL: 2 };

/** The e-mail policy for one notice, after the type's priority threshold. */
export function emailPolicyFor(type: string, priority: NotificationPriority = "NORMAL"): EmailPolicy {
  const d = typeDef(type);
  if (d.emailMinPriority && PRIORITY_RANK[priority] < PRIORITY_RANK[d.emailMinPriority]) return "none";
  return d.email;
}

/**
 * The preference table stays short: the same types people could tune before, plus the morning
 * summary. Everything else follows sensible defaults quietly; mandatory types show locked.
 */
const STAFF_TUNABLE = ["task.assigned", "task.due_soon", "task.overdue", "approval.requested", "approval.decided", "approval.rejected", "delivery.failed", "delivery.assigned", "incident.reported", "event.approaching", "comment.mentioned", "change_request.created", "digest.daily"];
const EXTERNAL_TUNABLE = ["approval.requested", "change_request.responded"];

function tunable(types: string[]) {
  return types.map((type) => {
    const d = typeDef(type);
    return { type, key: d.key, mandatory: d.email === "mandatory" && !d.emailMinPriority, email: d.email };
  });
}

/** Notification types users can tune, mapped to their message keys. Internal staff vs. external users see different sets. */
export const STAFF_NOTIFICATION_TYPES = tunable(STAFF_TUNABLE);
export const EXTERNAL_NOTIFICATION_TYPES = tunable(EXTERNAL_TUNABLE);
export type TunableType = (typeof STAFF_NOTIFICATION_TYPES)[number];

/** Escalation levels on a notice: 1 = owner reminded (overdue), 2+ = escalated above the owner (§3.4). */
export const ESCALATED_FROM_LEVEL = 2;
