"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import * as projects from "@/server/modules/projects/service";
import { createProjectSchema, deliverableSchema, independentApprovalSchema, memberSchema, milestoneSchema, projectSchema, riskSchema } from "@/server/modules/projects/schemas";
import { LIFECYCLE_TARGETS, statusChangeInput } from "@/server/modules/projects/lifecycle";
import * as tasks from "@/server/modules/tasks/service";
import * as approvals from "@/server/modules/approvals/service";
import * as templates from "@/server/modules/templates/service";
import { signedUrlFor } from "@/server/modules/files/service";

export const createProjectAction = orgAction(createProjectSchema, async (ctx, i) => {
  const r = await projects.createProject(ctx, i);
  return { id: r.project.id, code: r.project.code };
});
export const updateProjectAction = orgAction(z.object({ id: z.string() }).and(projectSchema), (ctx, { id, ...i }) => projects.updateProject(ctx, id, i as never).then((p) => ({ id: p.id })));
/** Lifecycle moves (BUSINESS_RULES §1): the loaded version, a reason where required, the client notice on cancel. AT_RISK is not settable. */
export const setProjectStatusAction = orgAction(statusChangeInput, (ctx, { id, status, ...opts }) => projects.setProjectStatus(ctx, id, status, opts).then((p) => ({ status: p.status, version: p.version })));
/** The read-only impact preview the status dialog shows before cancel, close, hold, complete or reopen (LC rule 4). */
export const previewStatusAction = orgAction(z.object({ id: z.string(), status: z.enum(LIFECYCLE_TARGETS) }), (ctx, i) => projects.previewProjectStatusChange(ctx, i.id, i.status));
export const setIndependentApprovalAction = orgAction(independentApprovalSchema, (ctx, i) => projects.setIndependentApproval(ctx, i).then((p) => ({ version: p.version })));
export const upsertMemberAction = orgAction(memberSchema, (ctx, i) => projects.upsertProjectMember(ctx, i).then(() => null));
export const removeMemberAction = orgAction(z.object({ projectId: z.string(), userId: z.string() }), (ctx, i) => projects.removeProjectMember(ctx, i.projectId, i.userId));
export const saveMilestoneAction = orgAction(milestoneSchema, (ctx, i) => projects.saveMilestone(ctx, i).then(() => null));
export const saveRiskAction = orgAction(riskSchema, (ctx, i) => projects.saveRisk(ctx, i).then(() => null));
export const saveDeliverableAction = orgAction(deliverableSchema, (ctx, i) => projects.saveDeliverable(ctx, i).then(() => null));

export const previewTemplateAction = orgAction(z.object({ projectId: z.string(), templateId: z.string() }), (ctx, i) => templates.previewApply(ctx, i.projectId, i.templateId));
export const applyTemplateAction = orgAction(z.object({ projectId: z.string(), templateId: z.string() }), (ctx, i) => templates.applyTemplateToProject(ctx, i.projectId, i.templateId).then((r) => r.preview));

export const createTaskAction = orgAction(tasks.taskInput, (ctx, i) => tasks.createTask(ctx, i).then((t) => ({ id: t.id, number: t.number })));
export const updateTaskAction = orgAction(tasks.taskPatch, (ctx, i) => tasks.updateTask(ctx, i).then((t) => ({ version: t.version })));
export const changeTaskStatusAction = orgAction(z.object({ id: z.string(), status: z.string(), version: z.number().optional(), reason: z.string().nullish() }), (ctx, i) => tasks.changeTaskStatus(ctx, i).then((t) => ({ version: t.version, status: t.status })));
export const setCollaboratorsAction = orgAction(z.object({ taskId: z.string(), userIds: z.array(z.string()) }), (ctx, i) => tasks.setCollaborators(ctx, i.taskId, i.userIds));
export const addDependencyAction = orgAction(z.object({ taskId: z.string(), dependsOnId: z.string() }), (ctx, i) => tasks.addDependency(ctx, i.taskId, i.dependsOnId));
export const removeDependencyAction = orgAction(z.object({ taskId: z.string(), dependsOnId: z.string() }), (ctx, i) => tasks.removeDependency(ctx, i.taskId, i.dependsOnId));
export const addChecklistItemAction = orgAction(z.object({ taskId: z.string(), checklistId: z.string().nullish(), label: z.string().trim().min(1).max(300) }), (ctx, i) => tasks.addChecklistItem(ctx, i).then(() => null));
export const toggleChecklistItemAction = orgAction(z.object({ itemId: z.string(), done: z.boolean() }), (ctx, i) => tasks.toggleChecklistItem(ctx, i.itemId, i.done));
export const addCommentAction = orgAction(
  z.object({ entityType: z.enum(["TASK", "PROJECT", "DELIVERY", "APPROVAL", "BOOTH", "INCIDENT", "CHANGE_REQUEST"]), entityId: z.string(), projectId: z.string(), body: z.string().trim().min(1).max(8000), visibility: z.enum(["INTERNAL", "CLIENT"]), mentions: z.array(z.string()).max(20).optional() }),
  (ctx, i) => tasks.addComment(ctx, i).then(() => null),
);
export const bulkTasksAction = orgAction(tasks.bulkInput, tasks.bulkUpdateTasks);

export const requestApprovalAction = orgAction(approvals.genericRequestInput, (ctx, i) => approvals.requestApproval(ctx, i).then((a) => ({ id: a.id })));
export const withdrawApprovalAction = orgAction(approvals.withdrawInput, (ctx, i) => approvals.withdrawApproval(ctx, i).then((a) => ({ status: a.status })));
export const decideApprovalAction = orgAction(approvals.decideInput, (ctx, i) => approvals.decideApproval(ctx, i).then((a) => ({ status: a.status })));

export const fileUrlAction = orgAction(z.object({ attachmentId: z.string() }), (ctx, i) => signedUrlFor(ctx, i.attachmentId));
