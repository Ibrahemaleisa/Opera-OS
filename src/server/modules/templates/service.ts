import type { Prisma, Project } from "@/generated/prisma/client";
import { createDefaultReadiness } from "@/server/modules/events/service";
import { createId } from "@/lib/id";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan, assertNotArchived, projectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { reserveTaskNumbers } from "@/server/modules/tasks/numbering";
import { DEFAULT_STATUSES, definitionStats, validateDefinition, withCancelled, type TemplateDefinition } from "./definition";

const DAY = 86400_000;

const DEFAULT_INVITE_AR = "{{honorific}} {{name}}\nيسرنا دعوتكم لحضور {{event_name}} بتاريخ {{event_date}}.\nللتأكيد: {{rsvp_link}}\nلإيقاف الدعوات: {{opt_out_link}}";
const DEFAULT_INVITE_EN = "Dear {{honorific}} {{name}},\nYou are cordially invited to {{event_name}} on {{event_date}}.\nRSVP: {{rsvp_link}}\nUnsubscribe: {{opt_out_link}}";

export async function listTemplates(ctx: ServiceContext) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const templates = await tx.template.findMany({ where: { archived: false }, orderBy: [{ isSystem: "desc" }, { category: "asc" }, { createdAt: "asc" }], include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
    return templates.map((t) => {
      const def = validateDefinition(t.versions[0]?.definition);
      return { ...t, stats: def.ok ? definitionStats(def.value) : null, versions: undefined };
    });
  });
}

export async function getTemplate(ctx: ServiceContext, templateId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const t = await tx.template.findUnique({ where: { id: templateId }, include: { versions: { orderBy: { version: "desc" } } } });
    if (!t) throw new NotFoundError();
    const usage = await tx.templateInstance.groupBy({ by: ["versionNumber"], where: { templateKey: t.key }, _count: true });
    return { ...t, usage };
  });
}

/** Publishes a new immutable version. Existing projects keep the version they were created from. */
export async function publishVersion(ctx: ServiceContext, templateId: string, definition: unknown, changelog?: string) {
  assertCan(ctx, "template.manage");
  const v = validateDefinition(definition);
  if (!v.ok) throw new ValidationError("errors.validation", { definition: v.errors });
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    // row lock to serialize concurrent publishes
    const t = await tx.template.update({ where: { id: templateId }, data: { latestVersion: { increment: 1 } } });
    const version = await tx.templateVersion.create({
      data: { organizationId: ctx.orgId, templateId, version: t.latestVersion, definition: v.value as unknown as Prisma.InputJsonValue, changelog: changelog ?? null, createdById: ctx.userId },
    });
    await audit(tx, ctx, { action: "template.publish", entityType: "TEMPLATE", entityId: templateId, summary: `${t.key} v${t.latestVersion}`, meta: definitionStats(v.value) });
    return version;
  });
}

export async function createTemplate(ctx: ServiceContext, input: { nameAr: string; nameEn: string; category: string; descriptionAr?: string | null; descriptionEn?: string | null; cloneFromId?: string | null }) {
  assertCan(ctx, "template.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    let definition: TemplateDefinition = { workstreams: [{ key: "general", name: { ar: "عام", en: "General" }, kind: "GENERAL", tasks: [] }], milestones: [], deliverables: [], customFields: [], records: [], budget: [], dashboards: [], automations: [], roles: [] };
    if (input.cloneFromId) {
      const src = await tx.templateVersion.findFirst({ where: { templateId: input.cloneFromId }, orderBy: { version: "desc" } });
      if (!src) throw new NotFoundError();
      definition = src.definition as unknown as TemplateDefinition;
    }
    const key = `custom-${createId().slice(-8)}`;
    const t = await tx.template.create({ data: { organizationId: ctx.orgId, key, nameAr: input.nameAr, nameEn: input.nameEn, category: input.category, descriptionAr: input.descriptionAr, descriptionEn: input.descriptionEn, latestVersion: 1, createdById: ctx.userId } });
    await tx.templateVersion.create({ data: { organizationId: ctx.orgId, templateId: t.id, version: 1, definition: definition as unknown as Prisma.InputJsonValue, changelog: input.cloneFromId ? "Cloned" : "Created", createdById: ctx.userId } });
    await audit(tx, ctx, { action: "template.create", entityType: "TEMPLATE", entityId: t.id, summary: input.nameEn });
    return t;
  });
}

export async function archiveTemplate(ctx: ServiceContext, templateId: string) {
  assertCan(ctx, "template.manage");
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    await tx.template.update({ where: { id: templateId }, data: { archived: true } });
    await audit(tx, ctx, { action: "template.archive", entityType: "TEMPLATE", entityId: templateId });
  });
}

// ── Composition ─────────────────────────────────────────────────────────────

export interface Anchors {
  start: Date;
  event: Date;
  deadline: Date;
}

export function anchorsFor(project: Pick<Project, "startDate" | "eventStartAt" | "deadline">, now = new Date()): Anchors {
  const start = project.startDate ?? now;
  const event = project.eventStartAt ?? project.deadline ?? new Date(start.getTime() + 30 * DAY);
  const deadline = project.deadline ?? project.eventStartAt ?? event;
  return { start, event, deadline };
}

function at(anchors: Anchors, anchor: "start" | "event" | "deadline", offsetDays: number) {
  return new Date(anchors[anchor].getTime() + offsetDays * DAY);
}

/** Resolves workstream key collisions: logistics → logistics-2 → logistics-3 … */
export function resolveKey(key: string, taken: Set<string>): string {
  if (!taken.has(key)) return key;
  let i = 2;
  while (taken.has(`${key}-${i}`)) i++;
  return `${key}-${i}`;
}

export interface CompositionPreview {
  templateKey: string;
  version: number;
  workstreams: { key: string; resolvedKey: string; collision: boolean; tasks: number }[];
  stats: ReturnType<typeof definitionStats>;
  records: string[];
}

export function previewComposition(def: TemplateDefinition, existingKeys: string[], templateKey: string, version: number): CompositionPreview {
  const taken = new Set(existingKeys);
  const workstreams = def.workstreams.map((ws) => {
    const resolvedKey = resolveKey(ws.key, taken);
    taken.add(resolvedKey);
    return { key: ws.key, resolvedKey, collision: resolvedKey !== ws.key, tasks: ws.tasks.length };
  });
  return { templateKey, version, workstreams, stats: definitionStats(def), records: def.records.map((r) => r.type) };
}

/**
 * Instantiates one template version into a project inside the caller's transaction.
 * Everything is copied (workstreams, tasks, subtasks, checklists, dependencies, milestones,
 * deliverables, custom fields, operational records, budget lines) — later template edits
 * never alter this project. Composition is additive: several templates can be applied and
 * each keeps its own workstream identity.
 */
export async function applyTemplateVersion(tx: Tx, ctx: ServiceContext, project: Project, versionId: string) {
  const version = await tx.templateVersion.findUnique({ where: { id: versionId }, include: { template: true } });
  if (!version) throw new NotFoundError();
  const v = validateDefinition(version.definition);
  if (!v.ok) throw new ValidationError("errors.validation", { definition: v.errors });
  const def = v.value;
  const anchors = anchorsFor(project);
  const existing = await tx.workstream.findMany({ where: { projectId: project.id }, select: { key: true } });
  const preview = previewComposition(def, existing.map((w) => w.key), version.template.key, version.version);
  const members = await tx.projectMember.findMany({ where: { projectId: project.id } });
  const ownerForRole = (role?: string) => (role ? members.find((m) => m.role === role)?.userId ?? null : null);

  const instance = await tx.templateInstance.create({
    data: {
      organizationId: ctx.orgId,
      projectId: project.id,
      templateVersionId: version.id,
      templateKey: version.template.key,
      versionNumber: version.version,
      keyPrefix: preview.workstreams.some((w) => w.collision) ? preview.workstreams.map((w) => w.resolvedKey).join(",") : "",
      appliedById: ctx.userId,
      summary: preview as unknown as Prisma.InputJsonValue,
    },
  });

  const wsCount = await tx.workstream.count({ where: { projectId: project.id } });
  const wsIdByKey = new Map<string, string>();
  const totalTasks = def.workstreams.reduce((n, ws) => n + ws.tasks.length + ws.tasks.reduce((m, t) => m + t.subtasks.length, 0), 0);
  let nextNumber = totalTasks ? await reserveTaskNumbers(tx, project.id, totalTasks) : 0;
  const wsRows: Prisma.WorkstreamCreateManyInput[] = [];
  const taskRows: Prisma.TaskCreateManyInput[] = [];
  const checklistRows: Prisma.ChecklistCreateManyInput[] = [];
  const itemRows: Prisma.ChecklistItemCreateManyInput[] = [];
  const taskIdByKey = new Map<string, string>();
  const depPairs: [string, string][] = [];

  def.workstreams.forEach((ws, wi) => {
    const resolved = preview.workstreams[wi].resolvedKey;
    const wsId = createId();
    wsIdByKey.set(ws.key, wsId);
    const statuses = withCancelled(ws.statuses ?? DEFAULT_STATUSES);
    wsRows.push({
      id: wsId,
      organizationId: ctx.orgId,
      projectId: project.id,
      templateInstanceId: instance.id,
      key: resolved,
      name: ws.name.ar,
      nameEn: ws.name.en,
      kind: ws.kind,
      color: ws.color ?? null,
      statuses: statuses as unknown as Prisma.InputJsonValue,
      sortOrder: wsCount + wi,
    });
    ws.tasks.forEach((t, ti) => {
      const id = createId();
      taskIdByKey.set(t.key, id);
      const startAt = at(anchors, t.anchor, t.offsetDays);
      const dueAt = new Date(startAt.getTime() + Math.max(t.durationDays, 0) * DAY);
      const first = statuses.find((s) => s.category === "TODO") ?? statuses[0];
      taskRows.push({
        id,
        organizationId: ctx.orgId,
        projectId: project.id,
        workstreamId: wsId,
        number: nextNumber++,
        templateKey: `${version.template.key}:${t.key}`,
        title: ctx.locale === "en" ? t.title.en : t.title.ar,
        description: t.description ? (ctx.locale === "en" ? t.description.en : t.description.ar) : null,
        status: first.key,
        statusCategory: first.category,
        priority: t.priority,
        ownerId: ownerForRole(t.defaultRole),
        startAt,
        dueAt,
        slaHours: t.slaHours ?? null,
        estimateMinutes: t.estimateHours ? Math.round(t.estimateHours * 60) : null,
        requiresApproval: t.requiresApproval,
        clientVisible: t.clientVisible,
        tags: t.tags,
        sortOrder: ti,
        createdById: ctx.userId,
      });
      t.subtasks.forEach((st, si) => {
        taskRows.push({
          id: createId(),
          organizationId: ctx.orgId,
          projectId: project.id,
          workstreamId: wsId,
          parentId: id,
          number: nextNumber++,
          templateKey: `${version.template.key}:${t.key}:${st.key}`,
          title: ctx.locale === "en" ? st.title.en : st.title.ar,
          status: first.key,
          statusCategory: first.category,
          dueAt,
          sortOrder: si,
          createdById: ctx.userId,
        });
      });
      if (t.checklist.length) {
        const clId = createId();
        checklistRows.push({ id: clId, organizationId: ctx.orgId, taskId: id, title: ctx.locale === "en" ? "Checklist" : "قائمة التحقق" });
        t.checklist.forEach((c, ci) => itemRows.push({ organizationId: ctx.orgId, checklistId: clId, label: ctx.locale === "en" ? c.en : c.ar, sortOrder: ci }));
      }
      t.dependsOn.forEach((d) => depPairs.push([t.key, d]));
    });
  });

  await tx.workstream.createMany({ data: wsRows });
  if (taskRows.length) await tx.task.createMany({ data: taskRows.filter((r) => !r.parentId) });
  if (taskRows.some((r) => r.parentId)) await tx.task.createMany({ data: taskRows.filter((r) => r.parentId) });
  if (checklistRows.length) await tx.checklist.createMany({ data: checklistRows });
  if (itemRows.length) await tx.checklistItem.createMany({ data: itemRows });
  const deps = depPairs.map(([task, dep]) => ({ organizationId: ctx.orgId, taskId: taskIdByKey.get(task)!, dependsOnId: taskIdByKey.get(dep)! })).filter((d) => d.taskId && d.dependsOnId);
  if (deps.length) await tx.taskDependency.createMany({ data: deps, skipDuplicates: true });

  if (def.milestones.length)
    await tx.milestone.createMany({
      data: def.milestones.map((m, i) => ({
        organizationId: ctx.orgId,
        projectId: project.id,
        workstreamId: m.workstream ? wsIdByKey.get(m.workstream) ?? null : null,
        templateKey: `${version.template.key}:${m.key}`,
        title: ctx.locale === "en" ? m.title.en : m.title.ar,
        dueDate: at(anchors, m.anchor, m.offsetDays),
        clientVisible: m.clientVisible,
        sortOrder: i,
      })),
    });
  if (def.deliverables.length)
    await tx.deliverable.createMany({
      data: def.deliverables.map((d) => ({
        organizationId: ctx.orgId,
        projectId: project.id,
        workstreamId: d.workstream ? wsIdByKey.get(d.workstream) ?? null : null,
        templateKey: `${version.template.key}:${d.key}`,
        title: ctx.locale === "en" ? d.title.en : d.title.ar,
        dueDate: at(anchors, d.anchor, d.offsetDays),
        clientVisible: d.clientVisible,
        requiresApproval: d.requiresApproval,
      })),
    });
  for (const cf of def.customFields) {
    const exists = await tx.customFieldDefinition.findFirst({ where: { entityType: cf.entityType, projectId: project.id, key: cf.key } });
    if (!exists) await tx.customFieldDefinition.create({ data: { organizationId: ctx.orgId, projectId: project.id, entityType: cf.entityType, key: cf.key, labelAr: cf.labelAr, labelEn: cf.labelEn, fieldType: cf.fieldType, options: cf.options, required: cf.required } });
  }

  const created: Record<string, string[]> = {};
  for (const r of def.records) {
    const wsId = r.workstream ? wsIdByKey.get(r.workstream) ?? null : null;
    const name = ctx.locale === "en" ? r.name.en : r.name.ar;
    if (r.type === "PHYSICAL_CAMPAIGN" || r.type === "DIGITAL_CAMPAIGN") {
      const c = await tx.invitationCampaign.create({
        data: { organizationId: ctx.orgId, projectId: project.id, workstreamId: wsId, type: r.type === "PHYSICAL_CAMPAIGN" ? "PHYSICAL" : "DIGITAL", name, ...(r.type === "DIGITAL_CAMPAIGN" ? { channel: "SMS" as const, rsvpEnabled: true, qrEnabled: true, bodyTemplate: ctx.locale === "en" ? DEFAULT_INVITE_EN : DEFAULT_INVITE_AR } : {}), deliveryDeadline: anchors.event, createdById: ctx.userId },
      });
      (created.campaigns ??= []).push(c.id);
    } else if (r.type === "EVENT") {
      const e = await tx.event.create({
        data: { organizationId: ctx.orgId, projectId: project.id, workstreamId: wsId, name: project.name, type: project.type, startsAt: anchors.event, endsAt: project.eventEndAt ?? new Date(anchors.event.getTime() + 8 * 3600_000) },
      });
      await createDefaultReadiness(tx, ctx.orgId, e, ctx.locale);
      (created.events ??= []).push(e.id);
    } else if (r.type === "BOOTH" || r.type === "PAVILION") {
      const b = await tx.booth.create({ data: { organizationId: ctx.orgId, projectId: project.id, workstreamId: wsId, name: `${name} — ${project.name}`, kind: r.type, handoverAt: new Date(anchors.event.getTime() - DAY) } });
      (created.booths ??= []).push(b.id);
    }
  }
  if (project.budgetAmount && def.budget.length) {
    const total = Number(project.budgetAmount);
    for (const b of def.budget) {
      await tx.budget.upsert({
        where: { projectId_category: { projectId: project.id, category: b.category } },
        create: { organizationId: ctx.orgId, projectId: project.id, category: b.category, planned: Math.round(total * b.share * 100) / 100 },
        update: {},
      });
    }
  }
  await tx.project.update({ where: { id: project.id }, data: { serviceScopes: { push: version.template.key } } });
  await audit(tx, ctx, { action: "template.apply", entityType: "PROJECT", entityId: project.id, projectId: project.id, summary: `${version.template.key} v${version.version}`, meta: { ...preview.stats, records: created, collisions: preview.workstreams.filter((w) => w.collision).map((w) => w.resolvedKey) } });
  return { instanceId: instance.id, preview, created };
}

export async function applyTemplateToProject(ctx: ServiceContext, projectId: string, templateId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    assertNotArchived(scope);
    if (!scope.manage) throw new ForbiddenError();
    // applying templates is refused on hold and once completed (BUSINESS_RULES §1.6)
    if (scope.project.status === "ON_HOLD" || scope.project.status === "COMPLETED") throw new ValidationError("errors.projectInactive");
    const latest = await tx.templateVersion.findFirst({ where: { templateId }, orderBy: { version: "desc" } });
    if (!latest) throw new NotFoundError();
    return applyTemplateVersion(tx, ctx, scope.project, latest.id);
  });
}

export async function previewApply(ctx: ServiceContext, projectId: string, templateId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    await projectScope(tx, ctx, projectId);
    const latest = await tx.templateVersion.findFirst({ where: { templateId }, orderBy: { version: "desc" }, include: { template: true } });
    if (!latest) throw new NotFoundError();
    const v = validateDefinition(latest.definition);
    if (!v.ok) throw new ValidationError();
    const existing = await tx.workstream.findMany({ where: { projectId }, select: { key: true } });
    return previewComposition(v.value, existing.map((w) => w.key), latest.template.key, latest.version);
  });
}
