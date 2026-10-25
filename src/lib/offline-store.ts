"use client";

/**
 * Tiny IndexedDB wrapper for the field app: a mutation queue and pending evidence blobs.
 * Only operational data is persisted (ids, statuses, notes, photos awaiting upload) —
 * recipient contact data is never written to persistent storage.
 *
 * Every queued mutation records who made it (org + user). A device can be shared or handed over:
 * only the signed-in agent's own mutations are replayed under their session, other accounts'
 * mutations stay untouched until their owner signs in, and a mutation the server rejects moves to
 * a visible "needs attention" state instead of being dropped.
 */
// legacy identifier, kept so existing deployments and devices keep working (ARCHITECTURE.md §10): renaming would strand updates queued offline on drivers' phones
const DB = "operra-field";
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "clientMutationId" });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export type MutationState = "pending" | "attention";
export type AttentionReason = "rejected" | "conflict" | "upload" | "unknownOwner";

export interface QueuedMutation {
  clientMutationId: string;
  orgSlug: string;
  /** who recorded it; older entries may only carry the name, the oldest neither */
  userId?: string | null;
  userName?: string | null;
  deliveryId: string;
  to: string;
  version?: number;
  reason?: string | null;
  note?: string | null;
  receivedByName?: string | null;
  scheduledFor?: string | null;
  lat?: number | null;
  lng?: number | null;
  occurredAt: string;
  evidenceBlobIds?: string[];
  evidenceIds?: string[];
  /** "pending" (default) is replayed automatically; "attention" waits for the agent to resend or discard */
  state?: MutationState;
  attentionReason?: AttentionReason;
  /** i18n key (or server error key) of the last failure */
  lastError?: string;
  /** server status at the time of a conflict */
  conflictStatus?: string;
  createdAt: number;
}

export interface QueueOwner {
  orgSlug: string;
  userId?: string | null;
  userName?: string | null;
}

export type Ownership = "mine" | "other" | "unknown";

/** Whose mutation is this, relative to the signed-in agent? Pure, so it can be unit-tested. */
export function ownership(m: Pick<QueuedMutation, "orgSlug" | "userId" | "userName">, who: QueueOwner): Ownership {
  if (m.orgSlug !== who.orgSlug) return "other";
  if (m.userId && who.userId) return m.userId === who.userId ? "mine" : "other";
  if (m.userName && who.userName) return m.userName === who.userName ? "mine" : "other";
  return "unknown";
}

export interface QueueView {
  /** the agent's own mutations, replayed automatically, oldest first */
  pending: QueuedMutation[];
  /** the agent's mutations that need a decision, plus legacy entries without an owner (never auto-sent) */
  attention: QueuedMutation[];
  /** entries in this org that belong to another account on the same device */
  others: number;
}

/** Splits the device queue into what the signed-in agent can send, must review, and must leave alone. */
export function partitionQueue(all: QueuedMutation[], who: QueueOwner): QueueView {
  const view: QueueView = { pending: [], attention: [], others: 0 };
  for (const m of all) {
    const o = ownership(m, who);
    if (o === "other") {
      if (m.orgSlug === who.orgSlug) view.others++;
      continue;
    }
    if (o === "unknown") view.attention.push({ ...m, state: "attention", attentionReason: m.attentionReason ?? "unknownOwner" });
    else if (m.state === "attention") view.attention.push(m);
    else view.pending.push(m);
  }
  view.pending.sort((a, b) => a.createdAt - b.createdAt);
  view.attention.sort((a, b) => a.createdAt - b.createdAt);
  return view;
}

/** A mutation moved to "needs attention" with the reason shown to the agent. */
export function toAttention(m: QueuedMutation, reason: AttentionReason, error?: string, conflictStatus?: string): QueuedMutation {
  return { ...m, state: "attention", attentionReason: reason, lastError: error, conflictStatus };
}

/**
 * Prepares an attention item to be sent again by the signed-in agent. After a conflict the stale
 * version is dropped, so the server applies the change to the current state if it is still a valid
 * transition (otherwise it comes back as an attention item with the server's reason).
 */
export function toRetry(m: QueuedMutation, who: QueueOwner): QueuedMutation {
  const retried: QueuedMutation = { ...m, state: "pending", attentionReason: undefined, lastError: undefined, conflictStatus: undefined, userId: who.userId ?? m.userId, userName: who.userName ?? m.userName };
  if (m.attentionReason === "conflict" || m.attentionReason === "unknownOwner") retried.version = undefined;
  return retried;
}

export const queue = {
  all: () => tx<QueuedMutation[]>("queue", "readonly", (s) => s.getAll() as IDBRequest<QueuedMutation[]>),
  put: (m: QueuedMutation) => tx("queue", "readwrite", (s) => s.put(m)),
  remove: (id: string) => tx("queue", "readwrite", (s) => s.delete(id)),
};

export const blobs = {
  put: (id: string, blob: Blob, name: string) => tx("blobs", "readwrite", (s) => s.put({ id, blob, name })),
  get: (id: string) => tx<{ id: string; blob: Blob; name: string } | undefined>("blobs", "readonly", (s) => s.get(id) as IDBRequest<{ id: string; blob: Blob; name: string } | undefined>),
  remove: (id: string) => tx("blobs", "readwrite", (s) => s.delete(id)),
};
