import { z } from "zod";

const text = z.object({ ar: z.string().min(1), en: z.string().min(1) });
const key = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase-kebab key");

export const statusDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]*$/, "status key"),
  ar: z.string(),
  en: z.string(),
  category: z.enum(["TODO", "ACTIVE", "BLOCKED", "REVIEW", "DONE", "CANCELLED"]),
});
export type StatusDef = z.infer<typeof statusDef>;

export const DEFAULT_STATUSES: StatusDef[] = [
  { key: "todo", ar: "للتنفيذ", en: "To do", category: "TODO" },
  { key: "in_progress", ar: "قيد العمل", en: "In progress", category: "ACTIVE" },
  { key: "blocked", ar: "محجوب", en: "Blocked", category: "BLOCKED" },
  { key: "review", ar: "مراجعة", en: "In review", category: "REVIEW" },
  { key: "done", ar: "منجز", en: "Done", category: "DONE" },
];

const anchor = z.enum(["start", "event", "deadline"]);

export const taskDef = z.object({
  key,
  title: text,
  description: text.optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  anchor: anchor.default("start"),
  offsetDays: z.number().int().default(0),
  durationDays: z.number().int().min(0).default(1),
  estimateHours: z.number().min(0).optional(),
  slaHours: z.number().int().positive().optional(),
  requiresApproval: z.boolean().default(false),
  clientVisible: z.boolean().default(false),
  defaultRole: z.enum(["MANAGER", "LEAD", "MEMBER", "FREELANCER", "FIELD_AGENT"]).optional(),
  checklist: z.array(text).default([]),
  subtasks: z.array(z.object({ key, title: text })).default([]),
  dependsOn: z.array(key).default([]),
  tags: z.array(z.string()).default([]),
});
export type TaskDef = z.infer<typeof taskDef>;

export const workstreamDef = z.object({
  key,
  name: text,
  kind: z.enum(["GENERAL", "VIP_DELIVERY", "DIGITAL_INVITES", "EVENT_OPS", "CONFERENCE", "PROTOCOL", "BOOTH", "PAVILION"]).default("GENERAL"),
  color: z.string().optional(),
  statuses: z.array(statusDef).optional(),
  tasks: z.array(taskDef).default([]),
});

export const milestoneDef = z.object({ key, title: text, anchor: anchor.default("event"), offsetDays: z.number().int().default(0), clientVisible: z.boolean().default(true), workstream: key.optional() });
export const deliverableDef = z.object({ key, title: text, requiresApproval: z.boolean().default(false), clientVisible: z.boolean().default(true), workstream: key.optional(), anchor: anchor.default("event"), offsetDays: z.number().int().default(0) });

export const recordTypes = z.enum(["PHYSICAL_CAMPAIGN", "DIGITAL_CAMPAIGN", "EVENT", "GUEST_LIST", "BOOTH", "PAVILION"]);

export const templateDefinition = z.object({
  workstreams: z.array(workstreamDef).min(0),
  milestones: z.array(milestoneDef).default([]),
  deliverables: z.array(deliverableDef).default([]),
  customFields: z
    .array(
      z.object({
        entityType: z.enum(["PROJECT", "TASK", "RECIPIENT", "GUEST"]),
        key: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/),
        labelAr: z.string(),
        labelEn: z.string(),
        fieldType: z.enum(["TEXT", "NUMBER", "DATE", "SELECT", "BOOLEAN"]),
        options: z.array(z.string()).default([]),
        required: z.boolean().default(false),
      }),
    )
    .default([]),
  records: z.array(z.object({ type: recordTypes, name: text, workstream: key.optional() })).default([]),
  budget: z.array(z.object({ category: z.string(), share: z.number().min(0).max(1) })).default([]),
  dashboards: z.array(z.string()).default([]),
  automations: z.array(z.string()).default([]),
  roles: z.array(z.object({ role: z.enum(["MANAGER", "LEAD", "MEMBER", "FREELANCER", "FIELD_AGENT", "CLIENT_APPROVER"]), label: text })).default([]),
});

export type TemplateDefinition = z.infer<typeof templateDefinition>;

/** Validates structure plus referential integrity (dependency keys exist, no cycles). */
export function validateDefinition(input: unknown): { ok: true; value: TemplateDefinition } | { ok: false; errors: string[] } {
  const parsed = templateDefinition.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const def = parsed.data;
  const errors: string[] = [];
  const wsKeys = new Set<string>();
  const taskKeys = new Map<string, string[]>();
  for (const ws of def.workstreams) {
    if (wsKeys.has(ws.key)) errors.push(`duplicate workstream key ${ws.key}`);
    wsKeys.add(ws.key);
    for (const t of ws.tasks) {
      if (taskKeys.has(t.key)) errors.push(`duplicate task key ${t.key}`);
      taskKeys.set(t.key, t.dependsOn);
    }
  }
  for (const [k, deps] of taskKeys) for (const d of deps) if (!taskKeys.has(d)) errors.push(`task ${k} depends on unknown ${d}`);
  // cycle detection (DFS)
  const state = new Map<string, 1 | 2>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const d of taskKeys.get(k) ?? []) if (visit(d)) return true;
    state.set(k, 2);
    return false;
  };
  for (const k of taskKeys.keys()) if (visit(k)) { errors.push(`dependency cycle involving ${k}`); break; }
  for (const m of [...def.milestones, ...def.deliverables]) if (m.workstream && !wsKeys.has(m.workstream)) errors.push(`unknown workstream ${m.workstream}`);
  return errors.length ? { ok: false, errors } : { ok: true, value: def };
}

export function definitionStats(def: TemplateDefinition) {
  const tasks = def.workstreams.reduce((n, w) => n + w.tasks.length, 0);
  const subtasks = def.workstreams.reduce((n, w) => n + w.tasks.reduce((m, t) => m + t.subtasks.length, 0), 0);
  const checklistItems = def.workstreams.reduce((n, w) => n + w.tasks.reduce((m, t) => m + t.checklist.length, 0), 0);
  const dependencies = def.workstreams.reduce((n, w) => n + w.tasks.reduce((m, t) => m + t.dependsOn.length, 0), 0);
  return { workstreams: def.workstreams.length, tasks, subtasks, checklistItems, dependencies, milestones: def.milestones.length, deliverables: def.deliverables.length, records: def.records.length, customFields: def.customFields.length };
}
