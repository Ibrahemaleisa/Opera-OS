import type { Project, ProjectMember } from "@/generated/prisma/client";
import type { Tx } from "@/server/db/tenant";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import type { ServiceContext } from "./context";
import type { PermissionKey } from "./permissions";
import { isClientRole } from "./roles";

export function can(ctx: ServiceContext, permission: PermissionKey): boolean {
  return ctx.permissions.has("*") || ctx.permissions.has(permission);
}

export function canAny(ctx: ServiceContext, ...permissions: PermissionKey[]) {
  return permissions.some((p) => can(ctx, p));
}

export function assertCan(ctx: ServiceContext, permission: PermissionKey): void {
  if (!can(ctx, permission)) throw new ForbiddenError();
}

export interface ProjectScope {
  project: Project;
  member: ProjectMember | null;
  /** can edit project settings, members, workstreams */
  manage: boolean;
  /** can create/edit tasks and operational records */
  operate: boolean;
  finance: boolean;
  vip: boolean;
  export: boolean;
  approve: boolean;
  /** empty = all workstreams */
  workstreamIds: string[];
  /** 'assigned' = only tasks the user owns or collaborates on */
  taskScope: "all" | "assigned";
  /** client portal view: only clientVisible records */
  clientView: boolean;
  /** field agent: only their assigned deliveries */
  fieldOnly: boolean;
}

/**
 * Resolve the caller's scope within a project. Throws NotFound (not Forbidden) when the
 * caller has no access, so project existence is not leaked across scopes.
 * Runs inside a tenant transaction, so cross-tenant ids already resolve to nothing.
 */
export async function projectScope(tx: Tx, ctx: ServiceContext, projectId: string): Promise<ProjectScope> {
  const project = await tx.project.findUnique({ where: { id: projectId } });
  if (!project || project.organizationId !== ctx.orgId) throw new NotFoundError();
  const member = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: ctx.userId } } });
  return computeProjectScope(ctx, project, member);
}

export function computeProjectScope(ctx: ServiceContext, project: Project, member: ProjectMember | null): ProjectScope {
  const base = { project, member };
  if (ctx.permissions.has("*")) {
    return { ...base, manage: true, operate: true, finance: true, vip: true, export: true, approve: true, workstreamIds: [], taskScope: "all", clientView: false, fieldOnly: false };
  }
  const client = isClientRole(ctx.role);
  if (client) {
    if (!member || !can(ctx, "portal.access") || !project.clientPortal) throw new NotFoundError();
    return { ...base, manage: false, operate: false, finance: false, vip: false, export: false, approve: can(ctx, "portal.approve"), workstreamIds: [], taskScope: "assigned", clientView: true, fieldOnly: false };
  }
  if (ctx.role === "VENDOR") {
    if (!member) throw new NotFoundError();
    return { ...base, manage: false, operate: false, finance: false, vip: false, export: false, approve: false, workstreamIds: member.workstreamIds, taskScope: "assigned", clientView: false, fieldOnly: false };
  }
  if (ctx.role === "FIELD_AGENT") {
    if (!member) throw new NotFoundError();
    return { ...base, manage: false, operate: false, finance: false, vip: false, export: false, approve: false, workstreamIds: [], taskScope: "assigned", clientView: false, fieldOnly: true };
  }
  if (can(ctx, "project.viewAll")) {
    return {
      ...base,
      manage: can(ctx, "project.manage"),
      operate: can(ctx, "task.manage"),
      finance: can(ctx, "finance.view"),
      vip: can(ctx, "vip.viewSensitive"),
      export: can(ctx, "export.data"),
      approve: can(ctx, "approval.decide"),
      workstreamIds: [],
      taskScope: "all",
      clientView: false,
      fieldOnly: false,
    };
  }
  if (!member) throw new NotFoundError();
  const isManager = member.role === "MANAGER";
  const freelancer = ctx.role === "FREELANCER" || member.role === "FREELANCER";
  return {
    ...base,
    manage: isManager && can(ctx, "project.manage"),
    operate: can(ctx, "task.manage") || freelancer,
    finance: can(ctx, "finance.view") && (isManager || member.canViewFinance),
    vip: can(ctx, "vip.viewSensitive") && (isManager || member.canViewVip),
    export: can(ctx, "export.data") && (isManager || member.canExport),
    approve: can(ctx, "approval.decide") && (isManager || member.canApprove),
    workstreamIds: isManager ? [] : member.workstreamIds,
    taskScope: freelancer ? "assigned" : "all",
    clientView: false,
    fieldOnly: false,
  };
}

export function assertScope(cond: boolean): asserts cond {
  if (!cond) throw new ForbiddenError();
}

/** Prisma `where` fragment restricting projects to those the caller may see. */
export function projectVisibilityWhere(ctx: ServiceContext) {
  if (ctx.permissions.has("*") || (can(ctx, "project.viewAll") && !isClientRole(ctx.role) && !["VENDOR", "FIELD_AGENT"].includes(ctx.role))) {
    return { organizationId: ctx.orgId };
  }
  return { organizationId: ctx.orgId, members: { some: { userId: ctx.userId } } };
}

/** Prisma `where` fragment restricting tasks inside a project scope. */
export function taskVisibilityWhere(ctx: ServiceContext, scope: ProjectScope) {
  const where: Record<string, unknown> = { projectId: scope.project.id };
  if (scope.clientView) where.clientVisible = true;
  if (scope.taskScope === "assigned" && !scope.clientView) {
    where.OR = [{ ownerId: ctx.userId }, { collaborators: { some: { userId: ctx.userId } } }];
  }
  if (scope.workstreamIds.length) where.workstreamId = { in: scope.workstreamIds };
  return where;
}
