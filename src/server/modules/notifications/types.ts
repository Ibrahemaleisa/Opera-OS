/** Notification types users can tune, mapped to their message keys. Internal staff vs. external users see different sets. */
export const STAFF_NOTIFICATION_TYPES = [
  { type: "task.assigned", key: "notif.taskAssigned" },
  { type: "task.due_soon", key: "notif.taskDueSoon" },
  { type: "task.overdue", key: "notif.taskOverdue" },
  { type: "approval.requested", key: "notif.approvalRequested" },
  { type: "approval.decided", key: "notif.approvalApproved" },
  { type: "approval.rejected", key: "notif.approvalRejected" },
  { type: "delivery.failed", key: "notif.deliveryFailed" },
  { type: "delivery.assigned", key: "notif.deliveriesAssigned" },
  { type: "incident.reported", key: "notif.incidentReported" },
  { type: "event.approaching", key: "notif.eventApproaching" },
  { type: "comment.mentioned", key: "notif.mentioned" },
  { type: "change_request.created", key: "notif.changeRequest" },
];
export const EXTERNAL_NOTIFICATION_TYPES = [
  { type: "approval.requested", key: "notif.approvalRequested" },
  { type: "change_request.responded", key: "notif.changeRequestResponded" },
];
