"use client";

/**
 * Tiny IndexedDB wrapper for the field app: a mutation queue and pending evidence blobs.
 * Only operational data is persisted (ids, statuses, notes, photos awaiting upload) —
 * recipient contact data is never written to persistent storage.
 */
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

export interface QueuedMutation {
  clientMutationId: string;
  orgSlug: string;
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
  lastError?: string;
  createdAt: number;
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
