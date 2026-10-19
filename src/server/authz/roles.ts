import type { OrgRole } from "@/generated/prisma/enums";
import { ALL_PERMISSIONS, type PermissionKey } from "./permissions";

const OPS: PermissionKey[] = ALL_PERMISSIONS.filter(
  (p) => !["org.roles.manage", "portal.access", "portal.approve", "vendor.portal"].includes(p),
);

const PM: PermissionKey[] = [
  "org.members.view",
  "org.directory.manage",
  "project.create",
  "project.manage",
  "template.manage",
  "task.manage",
  "task.assign",
  "task.bulk",
  "approval.request",
  "approval.decide",
  "recipient.view",
  "recipient.manage",
  "recipient.import",
  "vip.viewSensitive",
  "delivery.view",
  "delivery.dispatch",
  "delivery.update",
  "campaign.manage",
  "campaign.send",
  "event.manage",
  "incident.report",
  "protocol.manage",
  "booth.manage",
  "vendor.view",
  "vendor.manage",
  "finance.view",
  "finance.manage",
  "export.data",
  "report.view",
];

export interface SystemRoleDef {
  key: string;
  baseRole: OrgRole;
  nameAr: string;
  nameEn: string;
  permissions: PermissionKey[];
}

/**
 * System roles seeded into every organization. Project-level capability flags
 * (finance/VIP/export/approve) on ProjectMember further scope PM/lead/employee access.
 */
export const SYSTEM_ROLES: SystemRoleDef[] = [
  { key: "owner", baseRole: "OWNER", nameAr: "مالك الوكالة", nameEn: "Agency Owner", permissions: [...ALL_PERMISSIONS].filter((p) => !["portal.access", "portal.approve", "vendor.portal"].includes(p)) },
  { key: "ops_director", baseRole: "OPS_DIRECTOR", nameAr: "مدير العمليات", nameEn: "Operations Director", permissions: OPS },
  { key: "project_manager", baseRole: "PROJECT_MANAGER", nameAr: "مدير مشروع", nameEn: "Project Manager", permissions: PM },
  {
    key: "team_lead",
    baseRole: "TEAM_LEAD",
    nameAr: "قائد فريق",
    nameEn: "Team Lead",
    permissions: ["org.members.view", "task.manage", "task.assign", "task.bulk", "approval.request", "recipient.view", "delivery.view", "delivery.dispatch", "delivery.update", "event.manage", "incident.report", "booth.manage", "vendor.view"],
  },
  {
    key: "employee",
    baseRole: "EMPLOYEE",
    nameAr: "موظف",
    nameEn: "Employee",
    permissions: ["task.manage", "approval.request", "recipient.view", "delivery.view", "incident.report", "vendor.view"],
  },
  { key: "freelancer", baseRole: "FREELANCER", nameAr: "مستقل / متعاقد", nameEn: "Freelancer / Contractor", permissions: ["incident.report"] },
  { key: "field_agent", baseRole: "FIELD_AGENT", nameAr: "مندوب توصيل", nameEn: "Field Delivery Agent", permissions: ["delivery.field"] },
  { key: "client", baseRole: "CLIENT", nameAr: "عميل", nameEn: "Client", permissions: ["portal.access"] },
  { key: "client_approver", baseRole: "CLIENT_APPROVER", nameAr: "معتمد لدى العميل", nameEn: "Client Approver", permissions: ["portal.access", "portal.approve"] },
  { key: "vendor", baseRole: "VENDOR", nameAr: "مورّد", nameEn: "Vendor / Supplier", permissions: ["vendor.portal"] },
];

/** Org roles that operate inside the agency workspace (vs. portal / field only). */
export const INTERNAL_ROLES: OrgRole[] = ["OWNER", "OPS_DIRECTOR", "PROJECT_MANAGER", "TEAM_LEAD", "EMPLOYEE", "FREELANCER"];
export const EXTERNAL_ROLES: OrgRole[] = ["CLIENT", "CLIENT_APPROVER", "VENDOR"];

export function isClientRole(role: OrgRole) {
  return role === "CLIENT" || role === "CLIENT_APPROVER";
}

/** Where a member lands after login. */
export function homePathFor(role: OrgRole, slug: string) {
  if (isClientRole(role)) return `/portal/${slug}`;
  if (role === "FIELD_AGENT") return `/field/${slug}`;
  if (role === "VENDOR") return `/vendor/${slug}`;
  return `/o/${slug}`;
}
