import { z } from "zod";
import type { Event } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan, assertNotArchived, can, projectScope, projectVisibilityWhere, ProjectArchivedError, type ProjectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { casUpdate, versionField } from "@/server/concurrency";
import { audit } from "@/server/modules/audit/audit";
import { emit } from "@/server/modules/automation/outbox";

// ── Schemas ─────────────────────────────────────────────────────────────────

const id = z.string().min(1).max(40);
const optDate = z.coerce.date().nullish();
const optText = (max = 500) => z.string().trim().max(max).nullish();

export const eventSchema = z.object({
  id,
  name: z.string().trim().min(2).max(200),
  nameEn: optText(200),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  phase: z.enum(["PLANNING", "SETUP", "REHEARSAL", "LIVE", "TEARDOWN", "CLOSED"]),
  venueId: z.string().nullish(),
  expectedGuests: z.coerce.number().int().min(0).max(1_000_000).nullish(),
  brief: optText(5000),
  version: versionField,
});

export const sessionSchema = z.object({
  id: id.optional(),
  eventId: id,
  title: z.string().trim().min(2).max(200),
  titleEn: optText(200),
  kind: z.enum(["KEYNOTE", "PANEL", "WORKSHOP", "BREAK", "CEREMONY", "SESSION"]).default("SESSION"),
  room: optText(100),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  speakerIds: z.array(z.string()).max(20).default([]),
  status: z.enum(["PLANNED", "CONFIRMED", "LIVE", "DONE", "CANCELLED"]).default("PLANNED"),
});

export const speakerSchema = z.object({
  id: id.optional(),
  eventId: id,
  name: z.string().trim().min(2).max(200),
  nameEn: optText(200),
  title: optText(200),
  organizationName: optText(200),
  topic: optText(300),
  phone: optText(30),
  email: z.string().trim().email().max(200).nullish().or(z.literal("").transform(() => null)),
  status: z.enum(["INVITED", "CONFIRMED", "MATERIALS_RECEIVED", "BRIEFED", "DECLINED"]).default("INVITED"),
  needs: optText(1000),
});

export const runItemSchema = z.object({
  id: id.optional(),
  eventId: id,
  startsAt: z.coerce.date(),
  durationMin: z.coerce.number().int().min(0).max(24 * 60).default(15),
  title: z.string().trim().min(2).max(200),
  cue: optText(1000),
  ownerId: z.string().nullish(),
  location: optText(100),
});

export const RUN_STATUSES = ["PENDING", "STANDBY", "GO", "DONE", "SKIPPED"] as const;

export const shiftSchema = z.object({
  id: id.optional(),
  eventId: id,
  userId: z.string().nullish(),
  role: z.string().trim().min(2).max(100),
  location: optText(100),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
});

export const READINESS_CATEGORIES = ["VENUE", "AV", "REGISTRATION", "PROTOCOL", "CATERING", "SECURITY", "LOGISTICS"] as const;

export const readinessSchema = z.object({
  id: id.optional(),
  eventId: id,
  category: z.enum(READINESS_CATEGORIES),
  label: z.string().trim().min(2).max(200),
  ownerId: z.string().nullish(),
  dueAt: optDate,
  note: optText(1000),
});

export const incidentSchema = z.object({
  projectId: id,
  eventId: z.string().nullish(),
  title: z.string().trim().min(3).max(200),
  description: optText(4000),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  location: optText(200),
});

export const incidentUpdateSchema = z.object({
  id,
  status: z.enum(["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
  ownerId: z.string().nullish(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  resolution: optText(4000),
  escalate: z.boolean().optional(),
});

export const logisticsSchema = z.object({
  id: id.optional(),
  projectId: id,
  eventId: z.string().nullish(),
  name: z.string().trim().min(2).max(200),
  category: z.enum(["EQUIPMENT", "TRANSPORT", "PRINT", "CATERING", "SIGNAGE"]).default("EQUIPMENT"),
  quantity: z.coerce.number().int().min(0).max(1_000_000).default(1),
  vendorId: z.string().nullish(),
  status: z.enum(["PLANNED", "ORDERED", "DELIVERED", "INSTALLED", "RETURNED"]).default("PLANNED"),
  neededBy: optDate,
  notes: optText(1000),
});

/** Default readiness checklist created for every event generated from a template. */
export const DEFAULT_READINESS: { category: (typeof READINESS_CATEGORIES)[number]; ar: string; en: string }[] = [
  { category: "VENUE", ar: "استلام القاعة ومطابقة المخطط", en: "Venue handover matches floor plan" },
  { category: "AV", ar: "اختبار الصوت والإضاءة والشاشات", en: "Sound, lighting and screens tested" },
  { category: "REGISTRATION", ar: "تجهيز مكتب التسجيل وأجهزة المسح", en: "Registration desk and scanners ready" },
  { category: "PROTOCOL", ar: "اعتماد خطة الاستقبال والمقاعد", en: "Reception and seating plan approved" },
  { category: "CATERING", ar: "تأكيد قوائم الضيافة والأعداد", en: "Catering menus and counts confirmed" },
  { category: "SECURITY", ar: "تنسيق الأمن ونقاط الدخول", en: "Security and entry points coordinated" },
  { category: "LOGISTICS", ar: "وصول المعدات واللوحات الإرشادية", en: "Equipment and signage delivered" },
];

export async function createDefaultReadiness(tx: Tx, orgId: string, event: Pick<Event, "id" | "startsAt">, locale: string) {
  await tx.readinessItem.createMany({
    data: DEFAULT_READINESS.map((r) => ({ organizationId: orgId, eventId: event.id, category: r.category, label: locale === "en" ? r.en : r.ar, dueAt: new Date(event.startsAt.getTime() - 86400_000) })),
  });
}

// ── Access helpers ──────────────────────────────────────────────────────────

/** Loads an event and the caller's project scope. Client and field users never see the operations workspace. */
async function loadEvent(tx: Tx, ctx: ServiceContext, eventId: string): Promise<{ event: Event; scope: ProjectScope }> {
  const event = await tx.event.findUnique({ where: { id: eventId } });
  if (!event) throw new NotFoundError();
  const scope = await projectScope(tx, ctx, event.projectId);
  if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
  return { event, scope };
}

async function editableEvent(tx: Tx, ctx: ServiceContext, eventId: string) {
  assertCan(ctx, "event.manage");
  const r = await loadEvent(tx, ctx, eventId);
  assertNotArchived(r.scope); // LC rule 5: archived projects are read-only (incidents have their own tail below)
  if (!r.scope.operate) throw new ForbiddenError();
  return r;
}

function assertRange(start: Date, end: Date, field = "endsAt") {
  if (end < start) throw new ValidationError("errors.validation", { [field]: ["events.endBeforeStart"] });
}

const scoped = (ctx: ServiceContext) => ({ orgId: ctx.orgId, userId: ctx.userId });

// ── Events ──────────────────────────────────────────────────────────────────

export async function listProjectEvents(ctx: ServiceContext, projectId: string) {
  return withTenant(scoped(ctx), async (tx) => {
    const scope = await projectScope(tx, ctx, projectId);
    if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
    const events = await tx.event.findMany({ where: { projectId }, orderBy: { startsAt: "asc" } });
    const ids = events.map((e) => e.id);
    const [ready, total, incidents] = await Promise.all([
      tx.readinessItem.groupBy({ by: ["eventId"], where: { eventId: { in: ids }, status: "READY" }, _count: true }),
      tx.readinessItem.groupBy({ by: ["eventId"], where: { eventId: { in: ids } }, _count: true }),
      tx.incident.groupBy({ by: ["eventId"], where: { eventId: { in: ids }, status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] } }, _count: true }),
    ]);
    const n = (rows: { eventId: string | null; _count: number }[], eid: string) => rows.find((r) => r.eventId === eid)?._count ?? 0;
    return {
      canManage: can(ctx, "event.manage") && scope.operate,
      events: events.map((e) => ({ ...e, readiness: { ready: n(ready, e.id), total: n(total, e.id) }, openIncidents: n(incidents, e.id) })),
    };
  });
}

export async function createEvent(ctx: ServiceContext, input: { projectId: string; name: string; startsAt: Date; endsAt: Date }) {
  assertCan(ctx, "event.manage");
  assertRange(input.startsAt, input.endsAt);
  return withTenant(scoped(ctx), async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    assertNotArchived(scope);
    if (!scope.operate || scope.clientView) throw new ForbiddenError();
    const ws = await tx.workstream.findFirst({ where: { projectId: input.projectId, kind: { in: ["CONFERENCE", "EVENT_OPS"] } } });
    const e = await tx.event.create({ data: { organizationId: ctx.orgId, projectId: input.projectId, workstreamId: ws?.id ?? null, name: input.name, type: scope.project.type, venueId: null, startsAt: input.startsAt, endsAt: input.endsAt } });
    await createDefaultReadiness(tx, ctx.orgId, e, ctx.locale);
    await audit(tx, ctx, { action: "event.create", entityType: "EVENT", entityId: e.id, projectId: e.projectId, summary: e.name });
    return e;
  });
}

export async function updateEvent(ctx: ServiceContext, input: z.output<typeof eventSchema>) {
  assertRange(input.startsAt, input.endsAt);
  return withTenant(scoped(ctx), async (tx) => {
    const { event } = await editableEvent(tx, ctx, input.id);
    if (input.venueId && !(await tx.venue.findUnique({ where: { id: input.venueId } }))) throw new NotFoundError();
    const { version, ...fields } = input;
    const data: Partial<typeof fields> = { ...fields };
    delete data.id;
    const e = await casUpdate<Event>({ tx, ctx, model: "event", id: event.id, version, data, entityType: "EVENT" });
    if (event.phase !== e.phase) await audit(tx, ctx, { action: "event.phase", entityType: "EVENT", entityId: e.id, projectId: e.projectId, summary: `${event.phase} → ${e.phase}` });
    else await audit(tx, ctx, { action: "event.update", entityType: "EVENT", entityId: e.id, projectId: e.projectId, summary: e.name });
    return e;
  });
}

/** Everything the event operations workspace needs, with speaker contact data masked without VIP access. */
export async function getEventWorkspace(ctx: ServiceContext, eventId: string) {
  return withTenant(scoped(ctx), async (tx) => {
    const { event, scope } = await loadEvent(tx, ctx, eventId);
    const [sessions, speakers, runOfShow, shifts, readiness, incidents, logistics, venues, members, guests] = await Promise.all([
      tx.eventSession.findMany({ where: { eventId }, orderBy: [{ startsAt: "asc" }, { sortOrder: "asc" }] }),
      tx.speaker.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } }),
      tx.runOfShowItem.findMany({ where: { eventId }, orderBy: [{ startsAt: "asc" }, { sortOrder: "asc" }] }),
      tx.shift.findMany({ where: { eventId }, orderBy: { startsAt: "asc" } }),
      tx.readinessItem.findMany({ where: { eventId }, orderBy: [{ category: "asc" }, { label: "asc" }] }),
      tx.incident.findMany({ where: { projectId: event.projectId, OR: [{ eventId }, { eventId: null }] }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200 }),
      tx.logisticsItem.findMany({ where: { projectId: event.projectId, OR: [{ eventId }, { eventId: null }] }, orderBy: { neededBy: "asc" } }),
      tx.venue.findMany({ select: { id: true, name: true, city: true }, orderBy: { name: "asc" } }),
      tx.membership.findMany({ where: { status: "ACTIVE", role: { baseRole: { notIn: ["CLIENT", "CLIENT_APPROVER", "VENDOR"] } } }, include: { user: { select: { id: true, name: true, nameAr: true } } } }),
      tx.guest.groupBy({ by: ["attendance"], where: { projectId: event.projectId, OR: [{ eventId }, { eventId: null }] }, _count: true }),
    ]);
    const people = members.map((m) => ({ id: m.user.id, name: (ctx.locale === "ar" ? m.user.nameAr : null) ?? m.user.name }));
    const mask = (v: string | null) => (!v ? null : scope.vip ? v : v.includes("@") ? v.replace(/^(.).*(@.*)$/, "$1•••$2") : `•••${v.slice(-4)}`);
    const readyCount = readiness.filter((r) => r.status === "READY").length;
    const now = Date.now();
    const current = runOfShow.find((r) => r.status === "GO") ?? null;
    const next = runOfShow.find((r) => r.status === "PENDING" || r.status === "STANDBY") ?? null;
    return {
      event,
      project: { id: scope.project.id, name: scope.project.name, code: scope.project.code },
      canManage: can(ctx, "event.manage") && scope.operate,
      canReport: (can(ctx, "incident.report") || can(ctx, "event.manage")) && !scope.archived,
      /** incident tail (§1.5): open incidents stay operable after the project is archived */
      canHandleIncidents: can(ctx, "event.manage") && (scope.archived ? scope.tailOperate : scope.operate),
      archived: scope.archived,
      sessions,
      speakers: speakers.map((s) => ({ ...s, phone: mask(s.phone), email: mask(s.email) })),
      runOfShow,
      current,
      next,
      shifts,
      readiness,
      readinessScore: readiness.length ? readyCount / readiness.length : null,
      incidents,
      logistics,
      venues,
      people,
      guests: Object.fromEntries(guests.map((g) => [g.attendance, g._count])) as Record<string, number>,
      live: event.phase === "LIVE" || (event.startsAt.getTime() <= now && event.endsAt.getTime() >= now),
    };
  });
}

// ── Agenda & speakers ───────────────────────────────────────────────────────

export async function saveSession(ctx: ServiceContext, input: z.output<typeof sessionSchema>) {
  assertRange(input.startsAt, input.endsAt);
  return withTenant(scoped(ctx), async (tx) => {
    const { event } = await editableEvent(tx, ctx, input.eventId);
    if (input.speakerIds.length) {
      const n = await tx.speaker.count({ where: { id: { in: input.speakerIds }, eventId: event.id } });
      if (n !== new Set(input.speakerIds).size) throw new NotFoundError();
    }
    const { id: sid, ...data } = input;
    const s = sid
      ? await (async () => {
          const r = await tx.eventSession.updateMany({ where: { id: sid, eventId: event.id }, data });
          if (!r.count) throw new NotFoundError();
          return tx.eventSession.findUniqueOrThrow({ where: { id: sid } });
        })()
      : await tx.eventSession.create({ data: { ...data, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: sid ? "session.update" : "session.create", entityType: "EVENT_SESSION", entityId: s.id, projectId: event.projectId, summary: s.title });
    return s;
  });
}

export async function deleteSession(ctx: ServiceContext, input: { id: string; eventId: string }) {
  return withTenant(scoped(ctx), async (tx) => {
    const { event } = await editableEvent(tx, ctx, input.eventId);
    const r = await tx.eventSession.deleteMany({ where: { id: input.id, eventId: event.id } });
    if (!r.count) throw new NotFoundError();
    await audit(tx, ctx, { action: "session.delete", entityType: "EVENT_SESSION", entityId: input.id, projectId: event.projectId });
    return { deleted: true };
  });
}

export async function saveSpeaker(ctx: ServiceContext, input: z.output<typeof speakerSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    const { event, scope } = await editableEvent(tx, ctx, input.eventId);
    const { id: sid, ...data } = input;
    let s;
    if (sid) {
      const existing = await tx.speaker.findFirst({ where: { id: sid, eventId: event.id } });
      if (!existing) throw new NotFoundError();
      // without VIP access the masked contact values are shown, so keep stored values unless explicitly changed
      const patch = scope.vip ? data : { ...data, phone: existing.phone, email: existing.email };
      s = await tx.speaker.update({ where: { id: sid }, data: patch });
    } else {
      s = await tx.speaker.create({ data: { ...data, organizationId: ctx.orgId } });
    }
    await audit(tx, ctx, { action: sid ? "speaker.update" : "speaker.create", entityType: "SPEAKER", entityId: s.id, projectId: event.projectId, summary: `${s.name} · ${s.status}` });
    return s;
  });
}

// ── Run of show ─────────────────────────────────────────────────────────────

export async function saveRunItem(ctx: ServiceContext, input: z.output<typeof runItemSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    const { event } = await editableEvent(tx, ctx, input.eventId);
    const { id: rid, ...data } = input;
    const r = rid
      ? await (async () => {
          const u = await tx.runOfShowItem.updateMany({ where: { id: rid, eventId: event.id }, data });
          if (!u.count) throw new NotFoundError();
          return tx.runOfShowItem.findUniqueOrThrow({ where: { id: rid } });
        })()
      : await tx.runOfShowItem.create({ data: { ...data, organizationId: ctx.orgId, sortOrder: await tx.runOfShowItem.count({ where: { eventId: event.id } }) } });
    await audit(tx, ctx, { action: rid ? "runofshow.update" : "runofshow.create", entityType: "RUN_OF_SHOW", entityId: r.id, projectId: event.projectId, summary: r.title });
    return r;
  });
}

/**
 * Live cue control. Only one cue can be GO at a time: calling GO completes the previous live cue.
 * Uses a compare-and-set on the expected status so two operators can't double-fire a cue.
 */
export async function setRunItemStatus(ctx: ServiceContext, input: { id: string; status: (typeof RUN_STATUSES)[number]; expected?: string }) {
  return withTenant(scoped(ctx), async (tx) => {
    const item = await tx.runOfShowItem.findUnique({ where: { id: input.id } });
    if (!item) throw new NotFoundError();
    const { event } = await editableEvent(tx, ctx, item.eventId);
    if (input.status === "GO") await tx.runOfShowItem.updateMany({ where: { eventId: event.id, status: "GO", id: { not: item.id } }, data: { status: "DONE" } });
    const r = await tx.runOfShowItem.updateMany({ where: { id: item.id, status: input.expected ?? item.status }, data: { status: input.status } });
    if (!r.count) throw new ConflictError();
    await audit(tx, ctx, { action: "runofshow.cue", entityType: "RUN_OF_SHOW", entityId: item.id, projectId: event.projectId, summary: `${item.title}: ${item.status} → ${input.status}` });
    return { status: input.status };
  });
}

// ── Staffing ────────────────────────────────────────────────────────────────

/** §1.6: ON_HOLD and COMPLETED projects take no new shifts. */
function assertRunning(scope: ProjectScope) {
  if (scope.project.status === "ON_HOLD" || scope.project.status === "COMPLETED") throw new AppError("errors.projectNotRunning", "PROJECT_NOT_RUNNING", 409);
}

export async function saveShift(ctx: ServiceContext, input: z.output<typeof shiftSchema>) {
  assertRange(input.startsAt, input.endsAt);
  return withTenant(scoped(ctx), async (tx) => {
    const { event, scope } = await editableEvent(tx, ctx, input.eventId);
    if (!input.id) assertRunning(scope);
    if (input.userId && !(await tx.membership.findFirst({ where: { userId: input.userId, status: "ACTIVE" } }))) throw new NotFoundError();
    if (input.userId) {
      // prevent double-booking the same person on overlapping shifts (cancelled shifts don't count)
      const clash = await tx.shift.findFirst({ where: { userId: input.userId, status: { not: "CANCELLED" }, id: input.id ? { not: input.id } : undefined, startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt } } });
      if (clash) throw new ValidationError("errors.validation", { userId: ["events.shiftClash"] });
    }
    const { id: sid, ...data } = input;
    const s = sid
      ? await (async () => {
          const u = await tx.shift.updateMany({ where: { id: sid, eventId: event.id }, data });
          if (!u.count) throw new NotFoundError();
          return tx.shift.findUniqueOrThrow({ where: { id: sid } });
        })()
      : await tx.shift.create({ data: { ...data, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: sid ? "shift.update" : "shift.create", entityType: "SHIFT", entityId: s.id, projectId: event.projectId, summary: s.role });
    return s;
  });
}

/** Staff check in themselves; managers can mark check-in, completion or no-show for anyone. */
export async function setShiftStatus(ctx: ServiceContext, input: { id: string; status: "CHECKED_IN" | "COMPLETED" | "NO_SHOW" | "SCHEDULED" }) {
  return withTenant(scoped(ctx), async (tx) => {
    const shift = await tx.shift.findUnique({ where: { id: input.id } });
    if (!shift) throw new NotFoundError();
    const { event, scope } = await loadEvent(tx, ctx, shift.eventId);
    assertNotArchived(scope);
    // a shift cancelled with its project (§1.3) is not restored by a later reopen
    if (shift.status === "CANCELLED") throw new ValidationError("errors.invalidTransition");
    const self = shift.userId === ctx.userId && input.status === "CHECKED_IN";
    if (!self && !(can(ctx, "event.manage") && scope.operate)) throw new ForbiddenError();
    const s = await tx.shift.update({ where: { id: shift.id }, data: { status: input.status, checkedInAt: input.status === "CHECKED_IN" ? new Date() : shift.checkedInAt } });
    await audit(tx, ctx, { action: "shift.status", entityType: "SHIFT", entityId: s.id, projectId: event.projectId, summary: `${s.role}: ${input.status}` });
    return s;
  });
}

// ── Readiness ───────────────────────────────────────────────────────────────

export async function saveReadiness(ctx: ServiceContext, input: z.output<typeof readinessSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    const { event } = await editableEvent(tx, ctx, input.eventId);
    const { id: rid, ...data } = input;
    const r = rid
      ? await (async () => {
          const u = await tx.readinessItem.updateMany({ where: { id: rid, eventId: event.id }, data });
          if (!u.count) throw new NotFoundError();
          return tx.readinessItem.findUniqueOrThrow({ where: { id: rid } });
        })()
      : await tx.readinessItem.create({ data: { ...data, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: rid ? "readiness.update" : "readiness.create", entityType: "READINESS", entityId: r.id, projectId: event.projectId, summary: r.label });
    return r;
  });
}

export async function setReadinessStatus(ctx: ServiceContext, input: { id: string; status: "PENDING" | "IN_PROGRESS" | "READY" | "ISSUE"; note?: string | null }) {
  return withTenant(scoped(ctx), async (tx) => {
    const item = await tx.readinessItem.findUnique({ where: { id: input.id } });
    if (!item) throw new NotFoundError();
    const { event } = await editableEvent(tx, ctx, item.eventId);
    if (input.status === "ISSUE" && !input.note?.trim() && !item.note) throw new ValidationError("errors.validation", { note: ["events.issueNeedsNote"] });
    const r = await tx.readinessItem.update({ where: { id: item.id }, data: { status: input.status, note: input.note ?? item.note } });
    await audit(tx, ctx, { action: "readiness.status", entityType: "READINESS", entityId: r.id, projectId: event.projectId, summary: `${r.label}: ${input.status}` });
    return r;
  });
}

// ── Incidents ───────────────────────────────────────────────────────────────

export async function reportIncident(ctx: ServiceContext, input: z.output<typeof incidentSchema>) {
  if (!can(ctx, "incident.report") && !can(ctx, "event.manage")) throw new ForbiddenError();
  return withTenant(scoped(ctx), async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    if (scope.clientView) throw new NotFoundError();
    // the incident tail (§1.5) covers the incidents already open, not new reports
    assertNotArchived(scope);
    if (input.eventId && !(await tx.event.findFirst({ where: { id: input.eventId, projectId: input.projectId } }))) throw new NotFoundError();
    const i = await tx.incident.create({ data: { ...input, organizationId: ctx.orgId, reportedById: ctx.userId } });
    await audit(tx, ctx, { action: "incident.report", entityType: "INCIDENT", entityId: i.id, projectId: i.projectId, summary: `${i.severity}: ${i.title}` });
    await emit(tx, ctx, "incident.reported", { projectId: i.projectId, incidentId: i.id, severity: i.severity, title: i.title, link: i.eventId ? `/projects/${i.projectId}/events/${i.eventId}?tab=incidents` : `/projects/${i.projectId}/events` });
    return i;
  });
}

const INCIDENT_FLOW: Record<string, string[]> = {
  OPEN: ["ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED"],
  ACKNOWLEDGED: ["IN_PROGRESS", "RESOLVED"],
  IN_PROGRESS: ["RESOLVED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: [],
};

export async function updateIncident(ctx: ServiceContext, input: z.output<typeof incidentUpdateSchema>) {
  assertCan(ctx, "event.manage");
  return withTenant(scoped(ctx), async (tx) => {
    const i = await tx.incident.findUnique({ where: { id: input.id } });
    if (!i) throw new NotFoundError();
    const scope = await projectScope(tx, ctx, i.projectId);
    // incident tail (BUSINESS_RULES §1.5): status, owner and resolution stay operable in archived projects
    if (!(scope.archived ? scope.tailOperate : scope.operate) || scope.clientView) throw new ForbiddenError();
    if (scope.archived && (input.escalate || (input.severity && input.severity !== i.severity))) throw new ProjectArchivedError();
    if (input.status && input.status !== i.status && !INCIDENT_FLOW[i.status]?.includes(input.status)) throw new ValidationError("errors.invalidTransition");
    if (input.status === "RESOLVED" && !(input.resolution ?? i.resolution)?.trim()) throw new ValidationError("errors.validation", { resolution: ["events.resolutionRequired"] });
    if (input.ownerId && !(await tx.membership.findFirst({ where: { userId: input.ownerId, status: "ACTIVE" } }))) throw new NotFoundError();
    const escalationLevel = input.escalate ? i.escalationLevel + 1 : i.escalationLevel;
    const severity = input.escalate && i.severity !== "CRITICAL" ? (({ LOW: "MEDIUM", MEDIUM: "HIGH", HIGH: "CRITICAL" }) as const)[i.severity] : input.severity ?? i.severity;
    const u = await tx.incident.update({
      where: { id: i.id },
      data: {
        status: input.status ?? i.status,
        ownerId: input.ownerId === undefined ? i.ownerId : input.ownerId,
        severity,
        escalationLevel,
        resolution: input.resolution ?? i.resolution,
        resolvedAt: input.status === "RESOLVED" ? new Date() : input.status === "IN_PROGRESS" ? null : i.resolvedAt,
      },
    });
    await audit(tx, ctx, { action: input.escalate ? "incident.escalate" : "incident.update", entityType: "INCIDENT", entityId: i.id, projectId: i.projectId, summary: `${i.status} → ${u.status} · ${u.severity}`, before: { status: i.status, severity: i.severity, ownerId: i.ownerId }, after: { status: u.status, severity: u.severity, ownerId: u.ownerId } });
    if (input.escalate) await emit(tx, ctx, "incident.reported", { projectId: i.projectId, incidentId: i.id, severity: u.severity, title: u.title, escalated: true, link: `/projects/${i.projectId}/events` });
    return u;
  });
}

// ── Logistics ───────────────────────────────────────────────────────────────

export async function saveLogistics(ctx: ServiceContext, input: z.output<typeof logisticsSchema>) {
  assertCan(ctx, "event.manage");
  return withTenant(scoped(ctx), async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    assertNotArchived(scope);
    if (!scope.operate || scope.clientView) throw new ForbiddenError();
    if (input.eventId && !(await tx.event.findFirst({ where: { id: input.eventId, projectId: input.projectId } }))) throw new NotFoundError();
    if (input.vendorId && !(await tx.vendor.findUnique({ where: { id: input.vendorId } }))) throw new NotFoundError();
    const { id: lid, ...data } = input;
    const l = lid
      ? await (async () => {
          const u = await tx.logisticsItem.updateMany({ where: { id: lid, projectId: input.projectId }, data });
          if (!u.count) throw new NotFoundError();
          return tx.logisticsItem.findUniqueOrThrow({ where: { id: lid } });
        })()
      : await tx.logisticsItem.create({ data: { ...data, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: lid ? "logistics.update" : "logistics.create", entityType: "LOGISTICS", entityId: l.id, projectId: l.projectId, summary: `${l.name} · ${l.status}` });
    return l;
  });
}

// ── Live command center (org level) ─────────────────────────────────────────

/** Events live now or within the next 72h (or in the last 12h) across projects visible to the caller. */
export async function commandCenter(ctx: ServiceContext, now = new Date()) {
  return withTenant(scoped(ctx), async (tx) => {
    const projects = await tx.project.findMany({ where: { ...projectVisibilityWhere(ctx), archivedAt: null }, select: { id: true, code: true, name: true } });
    const pids = projects.map((p) => p.id);
    const events = await tx.event.findMany({
      where: { projectId: { in: pids }, OR: [{ phase: "LIVE" }, { startsAt: { lte: new Date(now.getTime() + 72 * 3600_000) }, endsAt: { gte: new Date(now.getTime() - 12 * 3600_000) } }], NOT: { phase: "CLOSED" } },
      orderBy: { startsAt: "asc" },
      take: 50,
    });
    const eids = events.map((e) => e.id);
    const [readiness, cues, shifts, incidents, guests] = await Promise.all([
      tx.readinessItem.findMany({ where: { eventId: { in: eids } }, select: { eventId: true, status: true } }),
      tx.runOfShowItem.findMany({ where: { eventId: { in: eids }, status: { in: ["GO", "STANDBY", "PENDING"] } }, orderBy: { startsAt: "asc" } }),
      tx.shift.findMany({ where: { eventId: { in: eids } }, select: { eventId: true, status: true, startsAt: true } }),
      tx.incident.findMany({ where: { projectId: { in: pids }, status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] } }, orderBy: [{ severity: "desc" }, { createdAt: "asc" }], take: 100 }),
      tx.guest.groupBy({ by: ["eventId", "attendance"], where: { eventId: { in: eids } }, _count: true }),
    ]);
    const pmap = new Map(projects.map((p) => [p.id, p]));
    return {
      now,
      events: events.map((e) => {
        const r = readiness.filter((x) => x.eventId === e.id);
        const s = shifts.filter((x) => x.eventId === e.id && x.startsAt <= new Date(now.getTime() + 2 * 3600_000));
        const g = guests.filter((x) => x.eventId === e.id);
        const gCount = (k: string[]) => g.filter((x) => k.includes(x.attendance)).reduce((a, b) => a + b._count, 0);
        return {
          id: e.id,
          name: e.name,
          phase: e.phase,
          startsAt: e.startsAt,
          endsAt: e.endsAt,
          project: pmap.get(e.projectId)!,
          readiness: { ready: r.filter((x) => x.status === "READY").length, issues: r.filter((x) => x.status === "ISSUE").length, total: r.length },
          currentCue: cues.find((c) => c.eventId === e.id && c.status === "GO") ?? null,
          nextCue: cues.find((c) => c.eventId === e.id && c.status !== "GO") ?? null,
          staff: { checkedIn: s.filter((x) => x.status === "CHECKED_IN").length, due: s.filter((x) => x.status !== "COMPLETED").length, noShow: s.filter((x) => x.status === "NO_SHOW").length },
          guests: { arrived: gCount(["ARRIVED", "SEATED"]), expected: gCount(["EXPECTED", "CONFIRMED", "ARRIVED", "SEATED"]) },
          incidents: incidents.filter((i) => i.eventId === e.id || (i.eventId === null && i.projectId === e.projectId)).length,
        };
      }),
      incidents: incidents.map((i) => ({ ...i, project: pmap.get(i.projectId)! })),
    };
  });
}
