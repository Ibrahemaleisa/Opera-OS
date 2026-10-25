"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Camera, CheckCircle2, ChevronLeft, ChevronRight, Clock, CloudOff, LogOut, MapPin, MessageCircle, Navigation, Phone, RefreshCw, RotateCcw, ShieldAlert, Trash2, Truck, Undo2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ActionButton } from "@/components/app/action-button";
import { ConfirmAction } from "@/components/app/confirm-action";
import { DateText } from "@/components/app/date-text";
import { Field, NativeSelect } from "@/components/app/field";
import { StatusBadge } from "@/components/app/status-badge";
import { parseRiyadhDateTime } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { blobs, partitionQueue, queue, toAttention, toRetry, type QueueOwner, type QueueView, type QueuedMutation } from "@/lib/offline-store";
import { telHref, whatsappHref } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { logoutAction } from "@/app/actions/session";
import type { FieldDelivery } from "@/server/modules/delivery/service";
import { FAILURE_REASONS } from "@/server/modules/delivery/state-machine";

const ACTIVE = ["ASSIGNED", "OUT_FOR_DELIVERY", "FAILED_ATTEMPT", "RESCHEDULED"];
const SESSION_KEY = "opera-field-cache"; // sessionStorage only: cleared when the browser session ends
// in-progress first, then assigned, rescheduled, failed (by priority within each)
const ORDER: Record<string, number> = { OUT_FOR_DELIVERY: 0, ASSIGNED: 1, RESCHEDULED: 2, FAILED_ATTEMPT: 3 };
const PRI: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const EMPTY_VIEW: QueueView = { pending: [], attention: [], others: 0 };

function navHref(r: FieldDelivery["recipient"]) {
  if (r.lat != null && r.lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`;
  if (r.mapsUrl) return r.mapsUrl;
  if (r.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.address)}`;
  return null;
}

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

/** Asks the service worker to keep this shell and every asset it loaded, so the app opens offline after one visit. */
async function precacheShell(onDone: () => void) {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
    const reg = await navigator.serviceWorker.ready;
    const assets = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((u) => u.startsWith(`${location.origin}/_next/static/`));
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "PRECACHED") {
        navigator.serviceWorker.removeEventListener("message", onMessage);
        onDone();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    reg.active?.postMessage({ type: "PRECACHE", urls: [location.pathname, ...assets] });
  } catch {
    // no service worker (private mode, unsupported): the app still works online
  }
}

type FlushReport = { synced: number; attention: number; network: boolean; sessionExpired: boolean; server: boolean };

export function FieldApp({ orgSlug, orgName, agentName, userId }: { orgSlug: string; orgName: string; agentName: string; userId?: string }) {
  const { m, tk, locale } = useI18n();
  const f = m.delivery.field;
  const q = m.common.offlineQueue;
  const cd = m.common.confirmDialog;
  const who = useMemo<QueueOwner>(() => ({ orgSlug, userId: userId ?? null, userName: agentName }), [orgSlug, userId, agentName]);
  const [items, setItems] = useState<FieldDelivery[] | null>(null);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [view, setView] = useState<QueueView>(EMPTY_VIEW);
  const [syncing, setSyncing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [precached, setPrecached] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const signOutRef = useRef<HTMLButtonElement>(null);
  const flushing = useRef(false);
  const router = useRouter();

  const refreshQueue = useCallback(async () => {
    try {
      setView(partitionQueue(await queue.all(), who));
    } catch {
      setView(EMPTY_VIEW);
    }
  }, [who]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/o/${orgSlug}/field/deliveries`, { cache: "no-store" });
      if (res.status === 401) return void router.replace("/login");
      const json = await res.json();
      if (json.ok) {
        setItems(json.data);
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(json.data)); } catch { /* quota */ }
      }
    } catch {
      try { const c = sessionStorage.getItem(SESSION_KEY); if (c) setItems(JSON.parse(c)); else setItems((x) => x ?? []); } catch { setItems((x) => x ?? []); }
    }
  }, [orgSlug, router]);

  /** Uploads one mutation's pending photos. Network trouble stops the run; a rejected file needs the agent. */
  const uploadEvidence = useCallback(async (mut: QueuedMutation): Promise<"ok" | "network" | "session" | "transient" | { error: string }> => {
    const uploaded: string[] = [...(mut.evidenceIds ?? [])];
    for (const bid of mut.evidenceBlobIds ?? []) {
      const b = await blobs.get(bid);
      if (!b) continue;
      const fd = new FormData();
      fd.set("file", new File([b.blob], b.name, { type: b.blob.type }));
      fd.set("entityType", "DELIVERY");
      fd.set("entityId", mut.deliveryId);
      fd.set("kind", "EVIDENCE");
      let res: Response;
      try {
        res = await fetch(`/api/o/${orgSlug}/upload`, { method: "POST", body: fd });
      } catch {
        return "network";
      }
      if (res.status === 401) return "session";
      if (res.status === 413) return { error: "common.net.fileTooLarge" };
      const r = (await res.json().catch(() => null)) as { ok: boolean; error?: string; data?: { id: string } } | null;
      if (!r) return res.status >= 500 ? "transient" : { error: "common.net.uploadFailed" };
      if (!r.ok || !r.data) return r.error === "errors.unexpected" || res.status >= 500 ? "transient" : { error: r.error ?? "errors.unexpected" };
      uploaded.push(r.data.id);
      await blobs.remove(bid);
      // persist progress so a retry never uploads the same photo twice
      mut.evidenceIds = [...uploaded];
      mut.evidenceBlobIds = (mut.evidenceBlobIds ?? []).filter((x) => x !== bid);
      await queue.put(mut);
    }
    return "ok";
  }, [orgSlug]);

  const flush = useCallback(async (manual = false) => {
    if (flushing.current || !navigator.onLine) return;
    flushing.current = true;
    setSyncing(true);
    const report: FlushReport = { synced: 0, attention: 0, network: false, sessionExpired: false, server: false };
    try {
      const mine = partitionQueue(await queue.all(), who).pending;
      if (!mine.length) return;
      const ready: QueuedMutation[] = [];
      for (const mut of mine) {
        if (mut.evidenceBlobIds?.length) {
          const up = await uploadEvidence(mut);
          if (up === "network") { report.network = true; break; }
          if (up === "session") { report.sessionExpired = true; break; }
          if (up === "transient") { report.server = true; continue; }
          if (up !== "ok") { await queue.put(toAttention(mut, "upload", up.error)); report.attention++; continue; }
        }
        ready.push(mut);
      }
      if (!ready.length || report.network || report.sessionExpired) return;
      let res: Response;
      try {
        res = await fetch(`/api/o/${orgSlug}/field/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mutations: ready.map((x) => ({ deliveryId: x.deliveryId, to: x.to, version: x.version, reason: x.reason ?? null, note: x.note ?? null, receivedByName: x.receivedByName ?? null, scheduledFor: x.scheduledFor ?? null, lat: x.lat ?? null, lng: x.lng ?? null, evidenceIds: x.evidenceIds ?? [], clientMutationId: x.clientMutationId, occurredAt: x.occurredAt, source: "FIELD_OFFLINE" })),
          }),
        });
      } catch {
        report.network = true;
        return;
      }
      if (res.status === 401) { report.sessionExpired = true; return; }
      const json = (await res.json().catch(() => null)) as { ok: boolean; data?: { clientMutationId: string; ok: boolean; conflict?: { status: string }; error?: string }[] } | null;
      if (!json?.ok || !json.data) { report.server = true; return; }
      for (const r of json.data) {
        const mut = ready.find((x) => x.clientMutationId === r.clientMutationId);
        if (!mut) continue;
        if (r.ok) {
          await queue.remove(mut.clientMutationId);
          report.synced++;
        } else if (r.conflict) {
          await queue.put(toAttention(mut, "conflict", "common.offlineQueue.conflictWith", r.conflict.status));
          report.attention++;
        } else if (!r.error || r.error === "errors.unexpected") {
          // transient: stays pending and is retried automatically
          await queue.put({ ...mut, lastError: r.error ?? "errors.unexpected" });
          report.server = true;
        } else {
          await queue.put(toAttention(mut, "rejected", r.error));
          report.attention++;
        }
      }
    } catch (e) {
      console.error("[field] sync failed", e);
      report.server = true;
    } finally {
      flushing.current = false;
      setSyncing(false);
      await refreshQueue();
      await load();
      if (report.sessionExpired) toast.error(q.sessionExpired);
      else if (report.attention > 0) toast.warning(report.synced > 0 ? interpolate(q.partialSync, { synced: report.synced, n: report.attention }) : interpolate(q.allNeedAttention, { n: report.attention }));
      else if (report.synced > 0 && !report.network && !report.server) toast.success(f.synced, { duration: 1500 });
      else if (manual && (report.network || report.server)) toast.error(q.notSentOffline);
    }
  }, [orgSlug, who, uploadEvidence, refreshQueue, load, f, q]);

  useEffect(() => {
    // replay anything queued before a reload / while offline, then load fresh state
    // (state is set after the IndexedDB read resolves — this effect syncs with an external store)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshQueue().then(() => (navigator.onLine ? flush() : load()));
    void precacheShell(() => setPrecached(true));
    const on = () => flush();
    window.addEventListener("online", on);
    const id = setInterval(() => { if (navigator.onLine) flush(); }, 30_000);
    return () => { window.removeEventListener("online", on); clearInterval(id); };
  }, [load, refreshQueue, flush]);

  /** Records a status change locally (optimistic) and queues it; flushes immediately when online. */
  const record = async (d: FieldDelivery, to: string, extra: Partial<QueuedMutation> & { photo?: File | null }) => {
    const id = crypto.randomUUID();
    const already = view.pending.some((p) => p.deliveryId === d.id);
    let evidenceBlobIds: string[] = [];
    if (extra.photo) {
      const bid = crypto.randomUUID();
      await blobs.put(bid, extra.photo, extra.photo.name || "proof.jpg");
      evidenceBlobIds = [bid];
    }
    const rest: Partial<QueuedMutation> & { photo?: File | null } = { ...extra };
    delete rest.photo;
    // Persist first: the update survives the app being closed or reloaded right away.
    const mutation: QueuedMutation = { clientMutationId: id, orgSlug, userId: who.userId, userName: who.userName, deliveryId: d.id, to, version: already ? undefined : d.version, occurredAt: new Date().toISOString(), createdAt: Date.now(), evidenceBlobIds, lat: null, lng: null, state: "pending", ...rest };
    await queue.put(mutation);
    setItems((xs) => xs?.map((x) => (x.id === d.id ? { ...x, status: to as never, version: x.version + 1 } : x)) ?? xs);
    setOpenId(null);
    await refreshQueue();
    // Optional location stamp. The Geolocation API's own timeout only starts after the user
    // answers the permission prompt, so we race it against our own deadline.
    if (to === "DELIVERED" && "geolocation" in navigator) {
      const coords = await Promise.race([
        new Promise<{ lat: number; lng: number } | null>((resolve) => navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve(null), { timeout: 4000, maximumAge: 60_000 })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (coords && (await queue.all()).some((x) => x.clientMutationId === id)) await queue.put({ ...mutation, lat: coords.lat, lng: coords.lng });
    }
    if (navigator.onLine) flush();
  };

  const retry = async (mut: QueuedMutation) => {
    await queue.put(toRetry(mut, who));
    await refreshQueue();
    await flush(true);
  };

  const discard = async (mut: QueuedMutation) => {
    for (const bid of mut.evidenceBlobIds ?? []) await blobs.remove(bid).catch(() => undefined);
    await queue.remove(mut.clientMutationId);
    await refreshQueue();
  };

  const signOut = () => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* */ }
    navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_SHELL" });
    void logoutAction();
  };
  const unsynced = view.pending.length + view.attention.length;

  const active = useMemo(() => (items?.filter((d) => ACTIVE.includes(d.status)) ?? []).sort((a, b) => ORDER[a.status] - ORDER[b.status] || PRI[a.priority] - PRI[b.priority]), [items]);
  const done = useMemo(() => items?.filter((d) => !ACTIVE.includes(d.status)) ?? [], [items]);
  const current = items?.find((d) => d.id === openId) ?? null;
  const Chevron = locale === "ar" ? ChevronLeft : ChevronRight;
  const nameFor = (deliveryId: string) => {
    const d = items?.find((x) => x.id === deliveryId);
    return d ? `${d.recipient.honorific ?? ""} ${d.recipient.name ?? d.trackingCode}`.trim() : deliveryId.slice(-6);
  };
  const statusLabel = (s: string) => m.enums.deliveryStatus[s as keyof typeof m.enums.deliveryStatus] ?? s;
  const reasonFor = (mut: QueuedMutation) => {
    if (mut.attentionReason === "conflict") return interpolate(q.conflictWith, { status: statusLabel(mut.conflictStatus ?? "") });
    if (mut.attentionReason === "upload") return interpolate(q.uploadRejected, { error: tk(mut.lastError ?? "errors.unexpected") });
    if (mut.attentionReason === "unknownOwner") return q.needsAttentionHint;
    return tk(mut.lastError ?? "errors.unexpected");
  };

  return (
    <div className="mx-auto max-w-lg" data-precached={precached ? "1" : undefined}>
      <header className="sticky top-0 z-20 bg-plum px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 text-mist">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-xs text-lilac">{orgName}</div>
            <h1 className="truncate text-lg font-medium">{f.title}</h1>
          </div>
          <div className="flex items-center gap-3">
            <Button size="icon" variant="ghost" className="size-11 text-mist hover:bg-white/10 hover:text-mist" onClick={() => (online ? flush(true) : load())} aria-label={f.syncNow} aria-busy={syncing || undefined}><RefreshCw className={cn("size-5", syncing && "animate-spin")} /></Button>
            <span aria-hidden className="h-6 w-px bg-white/20" />
            <Button ref={signOutRef} size="icon" variant="ghost" className="size-11 text-mist hover:bg-white/10 hover:text-mist" onClick={() => (unsynced > 0 ? setSignOutOpen(true) : signOut())} aria-label={f.signOut} data-testid="field-signout"><LogOut className="size-5" /></Button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span role="status" className={cn("flex items-center gap-1 rounded-full px-2 py-0.5", online ? "bg-white/10" : "bg-warning text-white")} data-testid="field-online">
            {online ? <span aria-hidden className="size-1.5 rounded-full bg-success-on-dark" /> : <CloudOff aria-hidden className="size-3" />}{online ? f.online : f.offline}
          </span>
          {view.pending.length > 0 && <span className="rounded-full bg-white/10 px-2 py-0.5" data-testid="field-pending">{interpolate(f.pending, { n: view.pending.length })}</span>}
          <span className="ms-auto truncate text-mist/75">{agentName}</span>
        </div>
      </header>

      <p className="flex items-start gap-2 bg-warning-soft px-4 py-2 text-xs text-warning"><ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{f.privacy}</p>

      {view.attention.length > 0 && (
        <section aria-labelledby="field-attention-title" className="mx-4 mt-4 rounded-xl border border-warning/40 bg-warning-soft/60 p-3" data-testid="field-attention">
          <h2 id="field-attention-title" className="flex items-center gap-2 text-sm font-medium text-warning"><AlertTriangle aria-hidden className="size-4" />{interpolate(q.needsAttention, { n: view.attention.length })}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{q.needsAttentionHint}</p>
          <ul className="mt-3 grid gap-2">
            {view.attention.map((mut) => (
              <li key={mut.clientMutationId} className="surface grid gap-2 rounded-lg p-3" data-testid="field-attention-item">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{nameFor(mut.deliveryId)}</span>
                  <StatusBadge status={mut.to} label={statusLabel(mut.to)} />
                </div>
                <p className="text-sm">{reasonFor(mut)}</p>
                <p className="text-xs text-muted-foreground">{q.recordedAt} <DateText value={mut.occurredAt} format="datetime" /></p>
                <div className="grid grid-cols-2 gap-2">
                  <ActionButton variant="outline" className="h-11" action={() => retry(mut)} disabled={!online} data-testid="field-retry"><RotateCcw aria-hidden /> {q.sendAgain}</ActionButton>
                  <ConfirmAction
                    trigger={<Button variant="ghost" className="h-11 text-danger" data-testid="field-discard"><Trash2 aria-hidden /> {q.discard}</Button>}
                    title={cd.discardUpdateTitle}
                    description={cd.discardUpdateBody}
                    confirmLabel={q.discard}
                    destructive
                    onConfirm={() => discard(mut)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.others > 0 && <p className="mx-4 mt-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">{interpolate(q.otherAccount, { n: view.others })}</p>}

      {items === null ? (
        <div className="grid gap-3 p-4" aria-busy="true">{[1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />)}</div>
      ) : (
        <main id="main-content" className="grid gap-5 p-4">
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-medium"><Truck aria-hidden className="size-4" /> {f.active} <span className="tabular text-muted-foreground">({active.length})</span></h2>
            {active.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{f.empty}</p>}
            <ul className="grid gap-2.5">
              {active.map((d) => {
                const nav = navHref(d.recipient);
                const queued = view.pending.some((p) => p.deliveryId === d.id);
                const needsAttention = view.attention.some((p) => p.deliveryId === d.id);
                return (
                  <li key={d.id} className="surface overflow-hidden rounded-xl" data-testid="field-card" data-status={d.status} data-delivery-id={d.id}>
                    <button className="flex w-full items-start gap-3 p-3.5 text-start focus-visible:ring-2 focus-visible:ring-lilac focus-visible:outline-none focus-visible:ring-inset" onClick={() => setOpenId(d.id)}>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge status={d.status} label={m.enums.deliveryStatus[d.status]} />
                          {d.priority === "CRITICAL" || d.priority === "HIGH" ? <StatusBadge status={d.priority} label={m.enums.priority[d.priority]} dot={false} /> : null}
                          {queued && <span className="flex items-center gap-1 rounded-full bg-warning-soft px-2 text-[11px] leading-5 font-medium text-warning" data-testid="field-card-queued"><CloudOff aria-hidden className="size-3" />{q.queuedBadge}</span>}
                          {needsAttention && <span className="flex items-center gap-1 rounded-full bg-danger-soft px-2 text-[11px] leading-5 font-medium text-danger"><AlertTriangle aria-hidden className="size-3" />{q.attentionBadge}</span>}
                        </div>
                        <div className="mt-1.5 text-[15px] leading-snug font-medium">{d.recipient.honorific} {d.recipient.name}</div>
                        <div className="text-xs text-muted-foreground">{d.recipient.organizationName}</div>
                        <div className="mt-1 flex items-center gap-1 text-sm"><MapPin aria-hidden className="size-3.5 text-muted-foreground" />{[d.recipient.city, d.recipient.district].filter(Boolean).join(" · ")}</div>
                        {d.recipient.preferredWindow && <div className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground"><Clock aria-hidden className="size-3.5" /><span className="ltr-nums">{d.recipient.preferredWindow}</span></div>}
                      </div>
                      <Chevron aria-hidden className="mt-1 size-5 text-muted-foreground" />
                    </button>
                    <div className="grid grid-cols-3 border-t text-sm">
                      {nav ? <a href={nav} target="_blank" rel="noreferrer noopener" className="flex h-12 items-center justify-center gap-1.5 hover:bg-muted"><Navigation aria-hidden className="size-4 text-primary" />{m.delivery.navigate}</a> : <span className="flex h-12 items-center justify-center text-muted-foreground">—</span>}
                      {d.recipient.mobile && !d.recipient.masked ? <a href={telHref(d.recipient.mobile)} className="flex h-12 items-center justify-center gap-1.5 border-x hover:bg-muted"><Phone aria-hidden className="size-4 text-primary" />{m.delivery.call}</a> : <span className="border-x" />}
                      {d.recipient.mobile && !d.recipient.masked ? <a href={whatsappHref(d.recipient.mobile)} target="_blank" rel="noreferrer noopener" className="flex h-12 items-center justify-center gap-1.5 hover:bg-muted"><MessageCircle aria-hidden className="size-4 text-primary" />{m.delivery.whatsapp}</a> : <span />}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
          {done.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">{f.completed} ({done.length})</h2>
              <ul className="grid gap-1.5">
                {done.map((d) => (
                  <li key={d.id} className="surface flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
                    <StatusBadge status={d.status} label={m.enums.deliveryStatus[d.status]} />
                    <span className="min-w-0 flex-1 truncate">{d.recipient.name}</span>
                    {d.deliveredAt && <DateText value={d.deliveredAt} format="time" className="text-xs text-muted-foreground" />}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">{f.hiddenAfter}</p>
            </section>
          )}
        </main>
      )}

      <Sheet open={!!current} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent side="bottom" closeClassName="top-2 end-2 size-11" className="max-h-[92dvh] overflow-y-auto rounded-t-2xl px-4 pt-5 pb-[max(env(safe-area-inset-bottom),16px)]">
          {current && <DeliverySheet d={current} onRecord={record} />}
        </SheetContent>
      </Sheet>

      <ConfirmAction
        open={signOutOpen}
        onOpenChange={setSignOutOpen}
        returnFocusTo={() => signOutRef.current}
        title={interpolate(cd.signOutPendingTitle, { n: unsynced })}
        description={cd.signOutPendingBody}
        confirmLabel={cd.signOutAnyway}
        destructive
        onConfirm={() => signOut()}
        testId="field-signout-confirm"
      />
    </div>
  );
}

function DeliverySheet({ d, onRecord }: { d: FieldDelivery; onRecord: (d: FieldDelivery, to: string, extra: Partial<QueuedMutation> & { photo?: File | null }) => Promise<void> }) {
  const { m } = useI18n();
  const f = m.delivery.field;
  const [mode, setMode] = useState<"" | "DELIVERED" | "FAILED_ATTEMPT" | "RESCHEDULED" | "RETURNED">("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [receivedBy, setReceivedBy] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const cfg = d.campaign ?? { requireEvidence: true, requireReceiverName: true };
  const r = d.recipient;
  const go = async (to: string, extra: Partial<QueuedMutation> & { photo?: File | null } = {}) => {
    setBusy(true);
    try {
      await onRecord(d, to, { note: note || null, ...extra });
    } finally {
      setBusy(false);
    }
  };
  const deliveredReady = (!cfg.requireEvidence || !!photo) && (!cfg.requireReceiverName || receivedBy.trim().length > 1);
  return (
    <div className="grid gap-4">
      <SheetHeader className="p-0 pe-12">
        <SheetTitle className="text-start text-lg">{r.honorific} {r.name}</SheetTitle>
        <div className="flex items-center gap-2"><StatusBadge status={d.status} label={m.enums.deliveryStatus[d.status]} /><span className="ltr-nums font-mono text-xs text-muted-foreground">{d.trackingCode}</span></div>
      </SheetHeader>
      <dl className="grid gap-2 rounded-xl bg-muted/50 p-3 text-sm">
        {r.organizationName && <div><dt className="text-xs text-muted-foreground">{m.projects.client}</dt><dd>{r.organizationName}</dd></div>}
        <div><dt className="text-xs text-muted-foreground">{m.common.address}</dt><dd>{r.address ?? "—"}<div className="text-xs text-muted-foreground">{[r.city, r.district].filter(Boolean).join(" · ")}</div></dd></div>
        {r.deliveryInstructions && <div><dt className="text-xs text-muted-foreground">{f.instructions}</dt><dd>{r.deliveryInstructions}</dd></div>}
        {r.mobile && <div><dt className="text-xs text-muted-foreground">{m.common.phone}</dt><dd><span className="ltr-nums">{r.mobile}</span></dd></div>}
        {d.scheduledFor && <div><dt className="text-xs text-muted-foreground">{m.delivery.scheduleFor}</dt><dd><DateText value={d.scheduledFor} format="datetime" /></dd></div>}
        {d.attempts.length > 0 && <div><dt className="text-xs text-muted-foreground">{m.delivery.attempts}</dt><dd className="text-xs">{d.attempts.map((a) => `#${a.attemptNo} ${a.failureReason ? (m.delivery.reasons as Record<string, string>)[a.failureReason] : a.outcome}`).join(" · ")}</dd></div>}
      </dl>

      {(d.status === "ASSIGNED" || d.status === "RESCHEDULED" || d.status === "FAILED_ATTEMPT") && !mode && (
        <Button size="lg" className="h-14 text-base" disabled={busy} onClick={() => go("OUT_FOR_DELIVERY")} data-testid="field-start"><Truck /> {f.start}</Button>
      )}
      {d.status === "OUT_FOR_DELIVERY" && !mode && (
        <div className="grid grid-cols-2 gap-2">
          <Button size="lg" className="col-span-2 h-14 bg-success text-base text-white hover:bg-success/90" onClick={() => setMode("DELIVERED")} data-testid="field-delivered"><CheckCircle2 /> {f.markDelivered}</Button>
          <Button size="lg" variant="outline" className="h-12" onClick={() => setMode("FAILED_ATTEMPT")} data-testid="field-failed"><XCircle className="text-danger" /> {f.markFailed}</Button>
          <Button size="lg" variant="outline" className="h-12" onClick={() => setMode("RESCHEDULED")} data-testid="field-reschedule"><RotateCcw /> {f.reschedule}</Button>
          <Button size="lg" variant="ghost" className="col-span-2 h-12" onClick={() => setMode("RETURNED")}><Undo2 /> {f.return}</Button>
        </div>
      )}
      {d.status === "FAILED_ATTEMPT" && !mode && <Button variant="ghost" className="h-12" onClick={() => setMode("RETURNED")}><Undo2 /> {f.return}</Button>}

      {mode && (
        <div className="grid gap-3 rounded-xl border p-3">
          {mode === "DELIVERED" && (
            <>
              <label className={cn("flex h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed text-sm focus-within:ring-2 focus-within:ring-lilac", photo && "border-success bg-success-soft text-success")}>
                <Camera aria-hidden className="size-6" />
                {photo ? f.photoAdded : f.takePhoto}
                <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} data-testid="field-photo" />
              </label>
              <Field label={m.delivery.receivedBy} required={cfg.requireReceiverName}>
                <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} className="h-12 text-base" autoComplete="off" data-testid="field-received-by" />
              </Field>
            </>
          )}
          {(mode === "FAILED_ATTEMPT" || mode === "RETURNED") && (
            <Field label={m.delivery.failureReason} required={mode === "FAILED_ATTEMPT"}>
              <NativeSelect className="h-12 text-base" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="field-reason">
                <option value="">{m.delivery.failureReason}…</option>
                {FAILURE_REASONS.map((x) => <option key={x} value={x}>{m.delivery.reasons[x]}</option>)}
              </NativeSelect>
            </Field>
          )}
          {mode === "RESCHEDULED" && (
            <Field label={m.delivery.scheduleFor} required>
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="h-12 text-base" dir="ltr" data-testid="field-when" />
            </Field>
          )}
          <Field label={m.common.notes}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="text-base" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" className="h-12" onClick={() => setMode("")}>{m.common.cancel}</Button>
            <Button
              className="h-12"
              data-testid="field-confirm"
              disabled={busy || (mode === "DELIVERED" && !deliveredReady) || (mode === "FAILED_ATTEMPT" && !reason) || (mode === "RESCHEDULED" && !when)}
              onClick={() =>
                mode === "DELIVERED" ? go("DELIVERED", { photo, receivedByName: receivedBy })
                : mode === "RESCHEDULED" ? go("RESCHEDULED", { scheduledFor: parseRiyadhDateTime(when)?.toISOString() ?? null })
                : go(mode, { reason: reason || null })
              }
            >
              {f.confirm}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
