/**
 * Permission catalog. Roles grant sets of these keys; services check them server-side.
 * Keep keys stable — they are stored on Role rows.
 */
export const PERMISSIONS = {
  // organization
  "org.manage": "Edit organization profile, branding and settings",
  "org.members.view": "View members",
  "org.members.manage": "Invite, change roles, suspend and revoke members",
  "org.roles.manage": "Create and edit custom roles",
  "org.audit.view": "View the organization audit log",
  "org.directory.manage": "Manage clients, contacts and venues",
  "org.customFields.manage": "Manage custom field definitions",
  // projects
  "project.viewAll": "See every project in the organization",
  "project.create": "Create projects",
  "project.manage": "Edit any project, its members and workstreams",
  "project.delete": "Archive or delete projects",
  // templates
  "template.manage": "Create, edit and publish templates",
  // tasks
  "task.manage": "Create, edit and assign tasks in accessible projects",
  "task.assign": "Assign or reassign tasks",
  "task.bulk": "Run bulk task actions",
  // approvals
  "approval.request": "Request approvals",
  "approval.decide": "Decide internal approvals",
  // VIP delivery
  "recipient.view": "View recipient registry (masked contact data)",
  "recipient.manage": "Create, edit and delete recipients",
  "recipient.import": "Run Excel imports",
  "vip.viewSensitive": "View unmasked VIP contact details",
  "delivery.view": "View delivery operations",
  "delivery.dispatch": "Create batches, assign and reassign deliveries",
  "delivery.update": "Update delivery status from the office",
  "delivery.field": "Use the field workspace for assigned deliveries",
  // digital
  "campaign.manage": "Create and edit digital campaigns",
  "campaign.approve": "Approve bulk outbound campaigns",
  "campaign.send": "Schedule and send approved campaigns",
  // events & protocol
  "event.manage": "Manage events, agenda, staff, readiness and incidents",
  "incident.report": "Report incidents",
  "protocol.manage": "Manage VIP protocol guests and assignments",
  "protocol.viewRestricted": "View restricted protocol notes",
  // production / vendors / finance
  "booth.manage": "Manage booth and pavilion production",
  "vendor.view": "View vendor directory",
  "vendor.manage": "Manage vendors, RFQs, quotes and work orders",
  "finance.view": "View budgets, costs and profitability",
  "finance.manage": "Edit budgets, POs and expenses",
  "finance.approve": "Approve financial items above threshold",
  // cross-cutting
  "export.data": "Export data (CSV/XLSX)",
  "automation.manage": "Configure automation rules",
  "report.view": "View organization reports and analytics",
  // external
  "portal.access": "Access the client portal",
  "portal.approve": "Approve or reject in the client portal",
  "vendor.portal": "Access assigned vendor work orders",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

export function permissionModule(key: string): string {
  return key.split(".")[0];
}
