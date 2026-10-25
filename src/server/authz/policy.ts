import type { Project, ProjectMember } from "@/generated/prisma/client";
import type { Tx } from "@/server/db/tenant";
import { AppError, ForbiddenError, NotFoundError } from "@/server/errors";
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
  /** CLOSED or CANCELLED: read-only except the financial and incident tails (BUSINESS_RULES §1.5) */
  archived: boolean;
  /** ON_HOLD, COMPLETED, CLOSED or CANCELLED: reminders and escalations are suppressed (§1.6) */
  quiet: boolean;
  /**
   * What `operate` would be if the project were not archived. Only for the §1.5 tails that stay
   * operable in archived projects (incidents, in-car deliveries); never for ordinary edits.
   */
  tailOperate: boolean;
}

/** Archived projects (BUSINESS_RULES §0): read-only after the status change. */
export const ARCHIVED_PROJECT_STATUSES = ["CLOSED", "CANCELLED"] as const;
/** Quiet projects (§0): no reminders or escalations, with the §1.6 exceptions. */
export const QUIET_PROJECT_STATUSES = ["ON_HOLD", "COMPLETED", "CLOSED", "CANCELLED"] as const;

export function isArchivedStatus(status: string) {
  return (ARCHIVED_PROJECT_STATUSES as readonly string[]).includes(status);
}

export function isQuietStatus(status: string) {
  return (QUIET_PROJECT_STATUSES as readonly string[]).includes(status);
}

/** LC rule 5: every mutation in an archived project is refused, except the listed tails. */
export class ProjectArchivedError extends AppError {
  constructor() {
    super("errors.projectArchived", "PROJECT_ARCHIVED", 409);
  }
}

export function assertNotArchived(scope: Pick<ProjectScope, "archived">): void {
  if (scope.archived) throw new ProjectArchivedError();
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
  const s = baseProjectScope(ctx, project, member);
  const archived = isArchivedStatus(project.status);
  const quiet = isQuietStatus(project.status);
  // archived projects are read-only: nobody manages or operates them (reopen uses project.delete)
  return { ...s, archived, quiet, tailOperate: s.operate, ...(archived ? { manage: false, operate: false } : {}) };
}

type BaseScope = Omit<ProjectScope, "archived" | "quiet" | "tailOperate">;

function baseProjectScope(ctx: ServiceContext, project: Project, member: ProjectMember | null): BaseScope {
  const base = { project, member };
  if (ctx.permissions.has("*")) {
    return { ...base, manage: true, operate: true, finance: true, vip: true, export: true, approve: true, workstreamIds: [], taskScope: "all", clientView: false, fieldOnly: false };
  }
  const client = isClientRole(ctx.role);
  if (client) {
    // the client contact must belong to the project's client company (re-assigning a project to
    // another client ends the previous client's access even if a stale membership row remains)
    if (!member || !can(ctx, "portal.access") || !project.clientPortal || (ctx.clientId ?? null) !== (project.clientId ?? null)) throw new NotFoundError();
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

/**
 * Project-level records (milestones, deliverables, risks) need project-wide operate scope:
 * freelancers operate only on the tasks assigned to them.
 */
export function operatesProject(scope: ProjectScope) {
  return scope.operate && scope.taskScope === "all" && !scope.clientView && !scope.fieldOnly;
}

export function assertScope(cond: boolean): asserts cond {
  if (!cond) throw new ForbiddenError();
}

/** Clients, vendors and field agents: they use their own surfaces, never the agency workspace. */
export function isExternalRole(role: ServiceContext["role"]) {
  return isClientRole(role) || role === "VENDOR" || role === "FIELD_AGENT";
}

/**
 * Prisma `where` fragment restricting projects to those the caller may see in the agency workspace
 * (portfolio, boards, search, reports). External roles get nothing here: their portals read
 * through dedicated, narrower services (portal, vendor portal, field deliveries).
 */
export function projectVisibilityWhere(ctx: ServiceContext) {
  if (ctx.permissions.has("*")) return { organizationId: ctx.orgId };
  if (isExternalRole(ctx.role)) return { organizationId: ctx.orgId, id: { in: [] as string[] } };
  if (can(ctx, "project.viewAll")) return { organizationId: ctx.orgId };
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
