import { z } from "zod";
import type { ServiceContext } from "@/server/authz/context";
import type { Tx } from "@/server/db/tenant";
import { ConflictError, NotFoundError, ValidationError, type ConflictDetails } from "@/server/errors";

/** Records protected by optimistic concurrency (BUSINESS_RULES §6). */
export type VersionedModel = "project" | "milestone" | "risk" | "deliverable" | "budget" | "recipient" | "guest" | "booth" | "event" | "invitationCampaign";

type Delegate = {
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  findUnique(args: { where: { id: string } }): Promise<Record<string, unknown> | null>;
};

/** Comparable form of a stored value: dates as ISO strings, decimals and JSON by their text. */
function norm(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const s = (v as { toJSON?: () => unknown }).toJSON?.() ?? v;
    return JSON.stringify(s);
  }
  return v;
}
const same = (a: unknown, b: unknown) => norm(a) === norm(b);

/** A plain, client-safe copy limited to the fields the caller was writing (never the whole row). */
function project(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of new Set(["id", "version", "updatedAt", ...keys])) if (k in row) out[k] = row[k];
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

/** Who changed the record last, from the audit trail. */
export async function lastChangedBy(tx: Tx, entityType: string, entityId: string): Promise<{ name: string; at: string } | null> {
  const a = await tx.auditEvent.findFirst({ where: { entityType, entityId }, orderBy: { createdAt: "desc" }, select: { actorName: true, createdAt: true } });
  return a ? { name: a.actorName ?? "—", at: a.createdAt.toISOString() } : null;
}

/**
 * Builds the CE-rule-4 details for a lost compare-and-set: the current values of the fields the
 * caller was changing, which of them differ from what the caller loaded (or, when that's not known,
 * from what the caller is writing), and who changed the record last.
 */
export async function conflictDetails(tx: Tx, opts: { model: VersionedModel; id: string; data: Record<string, unknown>; entityType: string; loaded?: Record<string, unknown>; redact?: string[] }): Promise<ConflictDetails> {
  const delegate = (tx as unknown as Record<string, Delegate>)[opts.model];
  const fresh = await delegate.findUnique({ where: { id: opts.id } });
  if (!fresh) throw new NotFoundError();
  const keys = Object.keys(opts.data).filter(
    (k) => !opts.redact?.includes(k) && (typeof opts.data[k] !== "object" || opts.data[k] === null || opts.data[k] instanceof Date || !("increment" in (opts.data[k] as object))),
  );
  const baseline = opts.loaded ?? opts.data;
  const changedFields = keys.filter((k) => k in fresh && k in baseline && !same(fresh[k], baseline[k]));
  return { current: project(fresh, keys), changedFields, changedBy: await lastChangedBy(tx, opts.entityType, opts.id) };
}

/**
 * Compare-and-set update (BUSINESS_RULES §6, CE-1..CE-3). Writes only when the stored version still
 * equals the version the caller loaded, and increments it. A missing version is a validation error;
 * a stale one throws ConflictError carrying {@link ConflictDetails} so the UI can offer reload /
 * re-apply mine / cancel. System and automation writes bump `version: { increment: 1 }` directly.
 *
 * `loaded` (optional) is what the caller saw when it loaded the record; with it, `changedFields`
 * names exactly the fields someone else changed. `redact` names written fields the caller may not
 * see in full (masked contacts, restricted notes): they are left out of the conflict details.
 */
export async function casUpdate<T>(opts: {
  tx: Tx;
  ctx: ServiceContext;
  model: VersionedModel;
  id: string;
  version: number | undefined;
  data: Record<string, unknown>;
  entityType: string;
  loaded?: Record<string, unknown>;
  redact?: string[];
}): Promise<T> {
  const { tx, model, id, version, data } = opts;
  if (version === undefined || version === null || !Number.isInteger(version)) throw new ValidationError("errors.versionRequired", { version: ["errors.versionRequired"] });
  const delegate = (tx as unknown as Record<string, Delegate>)[model];
  const res = await delegate.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } });
  if (res.count === 0) {
    const details = await conflictDetails(tx, { model, id, data, entityType: opts.entityType, loaded: opts.loaded, redact: opts.redact });
    throw new ConflictError("errors.staleWrite", details);
  }
  const row = await delegate.findUnique({ where: { id } });
  if (!row) throw new NotFoundError();
  return row as T;
}

/**
 * Checks the loaded version before a transition is judged (gates, allowed moves, approval state), so
 * a user acting on a stale page is told the record changed rather than given a rule error about a
 * state they never saw. The write itself must still be a {@link casUpdate} (the atomic check).
 */
export async function assertVersion(tx: Tx, opts: { model: VersionedModel; id: string; version: number | undefined; stored: number; entityType: string; data?: Record<string, unknown> }) {
  if (opts.version === undefined || opts.version === null || !Number.isInteger(opts.version)) throw new ValidationError("errors.versionRequired", { version: ["errors.versionRequired"] });
  if (opts.version !== opts.stored) throw new ConflictError("errors.staleWrite", await conflictDetails(tx, { model: opts.model, id: opts.id, data: opts.data ?? {}, entityType: opts.entityType }));
}

/** Schema field for the version a form loaded (required by casUpdate on updates; absent on creates). */
export const versionField = z.number().int().min(0).optional();
