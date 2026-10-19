import { z } from "zod";
import type { Guest } from "@/generated/prisma/client";
import type { ServiceContext } from "@/server/authz/context";
import { assertCan, can, projectScope, projectVisibilityWhere, type ProjectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";

const optText = (max = 500) => z.string().trim().max(max).nullish();

export const GUEST_CATEGORIES = ["VVIP", "VIP", "SPEAKER", "MEDIA", "DELEGATION", "GENERAL"] as const;
export const ATTENDANCE = ["EXPECTED", "CONFIRMED", "ARRIVED", "SEATED", "DEPARTED", "NO_SHOW", "CANCELLED"] as const;

export const guestSchema = z.object({
  id: z.string().optional(),
  projectId: z.string(),
  eventId: z.string().nullish(),
  nameAr: z.string().trim().min(2).max(200),
  nameEn: optText(200),
  honorific: optText(50),
  title: optText(200),
  organizationName: optText(200),
  category: z.enum(GUEST_CATEGORIES).default("VIP"),
  protocolLevel: z.coerce.number().int().min(1).max(5).default(3),
  mobile: optText(30),
  arrivalAt: z.coerce.date().nullish(),
  arrivalPoint: optText(100),
  specialInstructions: optText(1000),
  /** only honoured with protocol.viewRestricted */
  restrictedNotes: optText(2000),
});

export const zoneSchema = z.object({ id: z.string().optional(), eventId: z.string(), name: z.string().trim().min(1).max(100), capacity: z.coerce.number().int().min(0).max(100000), protocolLevel: z.coerce.number().int().min(1).max(5).nullish() });

export const assignmentSchema = z.object({
  id: z.string().optional(),
  guestId: z.string(),
  escortId: z.string().nullish(),
  checkpoint: optText(100),
  transport: optText(100),
  vehicle: optText(100),
  driverName: optText(100),
  pickupAt: z.coerce.date().nullish(),
  status: z.enum(["PLANNED", "CONFIRMED", "EN_ROUTE", "RECEIVED", "COMPLETED"]).default("PLANNED"),
  notes: optText(1000),
});

const scoped = (ctx: ServiceContext) => ({ orgId: ctx.orgId, userId: ctx.userId });

async function protocolScope(tx: Tx, ctx: ServiceContext, projectId: string) {
  const scope = await projectScope(tx, ctx, projectId);
  if (scope.clientView || scope.fieldOnly) throw new NotFoundError();
  return scope;
}

async function editable(tx: Tx, ctx: ServiceContext, projectId: string) {
  assertCan(ctx, "protocol.manage");
  const scope = await protocolScope(tx, ctx, projectId);
  if (!scope.operate) throw new ForbiddenError();
  return scope;
}

async function loadGuest(tx: Tx, ctx: ServiceContext, guestId: string) {
  const g = await tx.guest.findUnique({ where: { id: guestId } });
  if (!g) throw new NotFoundError();
  return g;
}

/** Data minimization: restricted notes never leave the server here; mobile is masked without VIP access. */
function present(g: Guest, scope: ProjectScope, locale: string) {
  const { restrictedNotes, mobile, ...rest } = g;
  return {
    ...rest,
    displayName: (locale === "en" ? g.nameEn ?? g.nameAr : g.nameAr) ?? "",
    mobile: mobile ? (scope.vip ? mobile : `•••${mobile.slice(-4)}`) : null,
    hasRestricted: !!restrictedNotes,
  };
}

export async function listGuests(ctx: ServiceContext, projectId: string, f: { eventId?: string; q?: string; attendance?: string; category?: string } = {}) {
  return withTenant(scoped(ctx), async (tx) => {
    const scope = await protocolScope(tx, ctx, projectId);
    const where = {
      projectId,
      ...(f.eventId ? { OR: [{ eventId: f.eventId }, { eventId: null }] } : {}),
      ...(f.attendance ? { attendance: f.attendance as never } : {}),
      ...(f.category ? { category: f.category } : {}),
      ...(f.q ? { AND: [{ OR: [{ nameAr: { contains: f.q, mode: "insensitive" as const } }, { nameEn: { contains: f.q, mode: "insensitive" as const } }, { organizationName: { contains: f.q, mode: "insensitive" as const } }, { seatLabel: { contains: f.q, mode: "insensitive" as const } }] }] } : {}),
    };
    const [guests, events, members, recipients] = await Promise.all([
      tx.guest.findMany({ where, include: { assignments: true }, orderBy: [{ protocolLevel: "asc" }, { nameAr: "asc" }], take: 2000 }),
      tx.event.findMany({ where: { projectId }, select: { id: true, name: true, startsAt: true }, orderBy: { startsAt: "asc" } }),
      tx.membership.findMany({ where: { status: "ACTIVE", role: { baseRole: { notIn: ["CLIENT", "CLIENT_APPROVER", "VENDOR"] } } }, include: { user: { select: { id: true, name: true, nameAr: true } } } }),
      tx.guest.findMany({ where: { projectId, recipientId: { not: null } }, select: { recipientId: true } }).then((linked) => tx.recipient.count({ where: { projectId, deletedAt: null, anonymizedAt: null, id: { notIn: linked.map((l) => l.recipientId!) } } })),
    ]);
    const eventIds = events.map((e) => e.id);
    const zones = await tx.seatingZone.findMany({ where: { eventId: { in: eventIds } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    const occupancy = await tx.guest.groupBy({ by: ["seatZoneId"], where: { projectId, seatZoneId: { not: null }, attendance: { notIn: ["CANCELLED", "NO_SHOW"] } }, _count: true });
    const counts = await tx.guest.groupBy({ by: ["attendance"], where: { projectId }, _count: true });
    return {
      scope: { manage: can(ctx, "protocol.manage") && scope.operate, vip: scope.vip, restricted: can(ctx, "protocol.viewRestricted") && scope.vip, export: scope.export },
      guests: guests.map((g) => ({ ...present(g, scope, ctx.locale), assignments: g.assignments })),
      events,
      zones: zones.map((z) => ({ ...z, occupied: occupancy.find((o) => o.seatZoneId === z.id)?._count ?? 0 })),
      people: members.map((m) => ({ id: m.user.id, name: (ctx.locale === "ar" ? m.user.nameAr : null) ?? m.user.name })),
      counts: Object.fromEntries(counts.map((c) => [c.attendance, c._count])) as Record<string, number>,
      unlinkedRecipients: recipients,
    };
  });
}

/** Restricted protocol notes: permission + project VIP scope required, and every read is audited. */
export async function revealRestrictedNotes(ctx: ServiceContext, guestId: string) {
  assertCan(ctx, "protocol.viewRestricted");
  return withTenant(scoped(ctx), async (tx) => {
    const g = await loadGuest(tx, ctx, guestId);
    const scope = await protocolScope(tx, ctx, g.projectId);
    if (!scope.vip) throw new ForbiddenError();
    await audit(tx, ctx, { action: "protocol.restricted_view", entityType: "GUEST", entityId: g.id, projectId: g.projectId, summary: g.nameAr });
    return { restrictedNotes: g.restrictedNotes, mobile: g.mobile };
  });
}

export async function saveGuest(ctx: ServiceContext, input: z.output<typeof guestSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    const scope = await editable(tx, ctx, input.projectId);
    if (input.eventId && !(await tx.event.findFirst({ where: { id: input.eventId, projectId: input.projectId } }))) throw new NotFoundError();
    const mayRestrict = can(ctx, "protocol.viewRestricted") && scope.vip;
    const { id, restrictedNotes, mobile, ...data } = input;
    if (id) {
      const existing = await tx.guest.findFirst({ where: { id, projectId: input.projectId } });
      if (!existing) throw new NotFoundError();
      const g = await tx.guest.update({
        where: { id },
        data: { ...data, mobile: scope.vip ? mobile ?? null : existing.mobile, restrictedNotes: mayRestrict && restrictedNotes !== undefined ? restrictedNotes : existing.restrictedNotes },
      });
      await audit(tx, ctx, { action: "guest.update", entityType: "GUEST", entityId: g.id, projectId: g.projectId, summary: g.nameAr, meta: { restrictedChanged: mayRestrict && restrictedNotes !== undefined && restrictedNotes !== existing.restrictedNotes } });
      return g;
    }
    const g = await tx.guest.create({ data: { ...data, mobile: mobile ?? null, restrictedNotes: mayRestrict ? restrictedNotes ?? null : null, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: "guest.create", entityType: "GUEST", entityId: g.id, projectId: g.projectId, summary: g.nameAr });
    return g;
  });
}

/** Creates protocol guests from the project's recipient registry (no re-keying of VIP data). */
export async function importGuestsFromRecipients(ctx: ServiceContext, input: { projectId: string; eventId?: string | null }) {
  return withTenant(scoped(ctx), async (tx) => {
    await editable(tx, ctx, input.projectId);
    if (input.eventId && !(await tx.event.findFirst({ where: { id: input.eventId, projectId: input.projectId } }))) throw new NotFoundError();
    const linked = await tx.guest.findMany({ where: { projectId: input.projectId, recipientId: { not: null } }, select: { recipientId: true } });
    const recipients = await tx.recipient.findMany({ where: { projectId: input.projectId, deletedAt: null, anonymizedAt: null, id: { notIn: linked.map((l) => l.recipientId!) } }, take: 5000 });
    const level = (tier: string | null) => (/vvip/i.test(tier ?? "") ? 1 : /honou?r|شرف/i.test(tier ?? "") ? 2 : /vip/i.test(tier ?? "") ? 2 : 3);
    await tx.guest.createMany({
      data: recipients.map((r) => ({
        organizationId: ctx.orgId,
        projectId: input.projectId,
        eventId: input.eventId ?? null,
        recipientId: r.id,
        nameAr: r.nameAr ?? r.nameEn ?? r.code,
        nameEn: r.nameEn,
        honorific: r.honorific,
        title: r.jobTitle,
        organizationName: r.organizationName,
        category: /vvip/i.test(r.vipTier ?? "") ? "VVIP" : "VIP",
        protocolLevel: level(r.vipTier),
        mobile: r.mobile,
      })),
    });
    await audit(tx, ctx, { action: "guest.import_recipients", entityType: "GUEST", projectId: input.projectId, summary: `${recipients.length} guests` });
    return { created: recipients.length };
  });
}

const ATTENDANCE_FLOW: Record<string, string[]> = {
  EXPECTED: ["CONFIRMED", "ARRIVED", "NO_SHOW", "CANCELLED"],
  CONFIRMED: ["ARRIVED", "NO_SHOW", "CANCELLED", "EXPECTED"],
  ARRIVED: ["SEATED", "DEPARTED"],
  SEATED: ["DEPARTED", "ARRIVED"],
  DEPARTED: ["ARRIVED"],
  NO_SHOW: ["ARRIVED", "EXPECTED"],
  CANCELLED: ["EXPECTED"],
};

/** Arrival desk transitions. Uses the stored status as a compare-and-set so two desks can't double-process. */
export async function setAttendance(ctx: ServiceContext, input: { guestId: string; attendance: (typeof ATTENDANCE)[number]; expected?: string }) {
  return withTenant(scoped(ctx), async (tx) => {
    const g = await loadGuest(tx, ctx, input.guestId);
    await editable(tx, ctx, g.projectId);
    if (input.expected && input.expected !== g.attendance) throw new ConflictError();
    if (!ATTENDANCE_FLOW[g.attendance]?.includes(input.attendance)) throw new ValidationError("errors.invalidTransition");
    const now = new Date();
    const r = await tx.guest.updateMany({
      where: { id: g.id, attendance: g.attendance },
      data: { attendance: input.attendance, ...(input.attendance === "ARRIVED" && g.attendance !== "SEATED" ? { arrivalAt: now } : {}), ...(input.attendance === "DEPARTED" ? { departureAt: now } : {}) },
    });
    if (!r.count) throw new ConflictError();
    if (input.attendance === "ARRIVED") await tx.protocolAssignment.updateMany({ where: { guestId: g.id, status: { in: ["PLANNED", "CONFIRMED", "EN_ROUTE"] } }, data: { status: "RECEIVED" } });
    await audit(tx, ctx, { action: "guest.attendance", entityType: "GUEST", entityId: g.id, projectId: g.projectId, summary: `${g.nameAr}: ${g.attendance} → ${input.attendance}` });
    return { attendance: input.attendance };
  });
}

export async function saveZone(ctx: ServiceContext, input: z.output<typeof zoneSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    const event = await tx.event.findUnique({ where: { id: input.eventId } });
    if (!event) throw new NotFoundError();
    await editable(tx, ctx, event.projectId);
    const { id, ...data } = input;
    const z = id
      ? await (async () => {
          const u = await tx.seatingZone.updateMany({ where: { id, eventId: event.id }, data });
          if (!u.count) throw new NotFoundError();
          return tx.seatingZone.findUniqueOrThrow({ where: { id } });
        })()
      : await tx.seatingZone.create({ data: { ...data, organizationId: ctx.orgId, sortOrder: await tx.seatingZone.count({ where: { eventId: event.id } }) } });
    await audit(tx, ctx, { action: id ? "zone.update" : "zone.create", entityType: "SEATING_ZONE", entityId: z.id, projectId: event.projectId, summary: `${z.name} (${z.capacity})` });
    return z;
  });
}

/**
 * Assigns a seat. Enforces zone capacity (serialized per zone with an advisory lock) and the
 * zone's minimum protocol level (level 1 = highest precedence).
 */
export async function assignSeat(ctx: ServiceContext, input: { guestId: string; seatZoneId: string | null; seatLabel?: string | null }) {
  return withTenant(scoped(ctx), async (tx) => {
    const g = await loadGuest(tx, ctx, input.guestId);
    await editable(tx, ctx, g.projectId);
    if (input.seatZoneId) {
      const zone = await tx.seatingZone.findUnique({ where: { id: input.seatZoneId } });
      const event = zone ? await tx.event.findUnique({ where: { id: zone.eventId } }) : null;
      if (!zone || !event || event.projectId !== g.projectId) throw new NotFoundError();
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`zone:${zone.id}`}))`;
      if (zone.protocolLevel && g.protocolLevel > zone.protocolLevel) throw new ValidationError("errors.validation", { seatZoneId: ["protocol.levelTooLow"] });
      if (g.seatZoneId !== zone.id && zone.capacity > 0) {
        const used = await tx.guest.count({ where: { seatZoneId: zone.id, attendance: { notIn: ["CANCELLED", "NO_SHOW"] } } });
        if (used >= zone.capacity) throw new ValidationError("errors.validation", { seatZoneId: ["protocol.zoneFull"] });
      }
      if (input.seatLabel) {
        const taken = await tx.guest.findFirst({ where: { seatZoneId: zone.id, seatLabel: input.seatLabel, id: { not: g.id } } });
        if (taken) throw new ValidationError("errors.validation", { seatLabel: ["protocol.seatTaken"] });
      }
    }
    const u = await tx.guest.update({ where: { id: g.id }, data: { seatZoneId: input.seatZoneId, seatLabel: input.seatZoneId ? input.seatLabel ?? null : null } });
    await audit(tx, ctx, { action: "guest.seat", entityType: "GUEST", entityId: g.id, projectId: g.projectId, summary: `${g.nameAr}: ${u.seatLabel ?? "—"}` });
    return u;
  });
}

export async function saveAssignment(ctx: ServiceContext, input: z.output<typeof assignmentSchema>) {
  return withTenant(scoped(ctx), async (tx) => {
    const g = await loadGuest(tx, ctx, input.guestId);
    await editable(tx, ctx, g.projectId);
    if (input.escortId && !(await tx.membership.findFirst({ where: { userId: input.escortId, status: "ACTIVE" } }))) throw new NotFoundError();
    const { id, ...data } = input;
    const a = id
      ? await (async () => {
          const u = await tx.protocolAssignment.updateMany({ where: { id, guestId: g.id }, data });
          if (!u.count) throw new NotFoundError();
          return tx.protocolAssignment.findUniqueOrThrow({ where: { id } });
        })()
      : await tx.protocolAssignment.create({ data: { ...data, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: id ? "protocol.assignment_update" : "protocol.assignment_create", entityType: "PROTOCOL_ASSIGNMENT", entityId: a.id, projectId: g.projectId, summary: `${g.nameAr} · ${a.status}` });
    return a;
  });
}

/** Org-level arrivals board: VIP guests for events today/tomorrow across visible projects. */
export async function arrivalsBoard(ctx: ServiceContext, now = new Date()) {
  return withTenant(scoped(ctx), async (tx) => {
    const projects = await tx.project.findMany({ where: { ...projectVisibilityWhere(ctx), archivedAt: null }, select: { id: true, code: true, name: true } });
    const events = await tx.event.findMany({ where: { projectId: { in: projects.map((p) => p.id) }, startsAt: { lte: new Date(now.getTime() + 48 * 3600_000) }, endsAt: { gte: new Date(now.getTime() - 12 * 3600_000) } }, orderBy: { startsAt: "asc" } });
    const guests = await tx.guest.findMany({
      where: { OR: [{ eventId: { in: events.map((e) => e.id) } }, { eventId: null, projectId: { in: events.map((e) => e.projectId) } }], protocolLevel: { lte: 2 } },
      include: { assignments: { select: { status: true, escortId: true, checkpoint: true } } },
      orderBy: [{ protocolLevel: "asc" }, { arrivalAt: "asc" }],
      take: 500,
    });
    const pmap = new Map(projects.map((p) => [p.id, p]));
    const projectsWithScope = new Map<string, ProjectScope>();
    for (const pid of new Set(guests.map((g) => g.projectId))) projectsWithScope.set(pid, await projectScope(tx, ctx, pid));
    return {
      events: events.map((e) => ({ id: e.id, name: e.name, startsAt: e.startsAt, phase: e.phase, project: pmap.get(e.projectId)! })),
      guests: guests.map((g) => ({ ...present(g, projectsWithScope.get(g.projectId)!, ctx.locale), assignments: g.assignments, project: pmap.get(g.projectId)! })),
    };
  });
}
