"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Camera, CheckCircle2, ChevronLeft, ChevronRight, Clock, CloudOff, LogOut, MapPin, MessageCircle, Navigation, Phone, RefreshCw, RotateCcw, ShieldAlert, Truck, Undo2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/app/field";
import { StatusBadge } from "@/components/app/status-badge";
import { formatDateTime, formatTime, parseRiyadhDateTime } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { blobs, queue, type QueuedMutation } from "@/lib/offline-store";
import { telHref, whatsappHref } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { logoutAction } from "@/app/actions/session";
import type { FieldDelivery } from "@/server/modules/delivery/service";
import { FAILURE_REASONS } from "@/server/modules/delivery/state-machine";

const ACTIVE = ["ASSIGNED", "OUT_FOR_DELIVERY", "FAILED_ATTEMPT", "RESCHEDULED"];
const SESSION_KEY = "operra-field-cache"; // sessionStorage only: cleared when the browser session ends

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

export function FieldApp({ orgSlug, orgName, agentName }: { orgSlug: string; orgName: string; agentName: string }) {
  const { m, fmt, tk, locale } = useI18n();
  const f = m.delivery.field;
  const [items, setItems] = useState<FieldDelivery[] | null>(null);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [pending, setPending] = useState<QueuedMutation[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const flushing = useRef(false);

  const refreshQueue = useCallback(async () => setPending((await queue.all()).filter((q) => q.orgSlug === orgSlug)), [orgSlug]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/o/${orgSlug}/field/deliveries`, { cache: "no-store" });
      if (res.status === 401) return void (window.location.href = "/login");
      const json = await res.json();
      if (json.ok) {
        setItems(json.data);
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(json.data)); } catch { /* quota */ }
      }
    } catch {
      try { const c = sessionStorage.getItem(SESSION_KEY); if (c) setItems(JSON.parse(c)); else setItems((x) => x ?? []); } catch { setItems((x) => x ?? []); }
    }
  }, [orgSlug]);

  const flush = useCallback(async () => {
    if (flushing.current || !navigator.onLine) return;
    flushing.current = true;
    setSyncing(true);
    try {
      const all = (await queue.all()).filter((q) => q.orgSlug === orgSlug).sort((a, b) => a.createdAt - b.createdAt);
      if (!all.length) return;
      // upload pending evidence first
      for (const q of all) {
        if (!q.evidenceBlobIds?.length) continue;
        const uploaded: string[] = [...(q.evidenceIds ?? [])];
        for (const bid of q.evidenceBlobIds) {
          const b = await blobs.get(bid);
          if (!b) continue;
          const fd = new FormData();
          fd.set("file", new File([b.blob], b.name, { type: b.blob.type }));
          fd.set("entityType", "DELIVERY");
          fd.set("entityId", q.deliveryId);
          fd.set("kind", "EVIDENCE");
          const r = await fetch(`/api/o/${orgSlug}/upload`, { method: "POST", body: fd }).then((x) => x.json());
          if (!r.ok) throw new Error(r.error);
          uploaded.push(r.data.id);
          await blobs.remove(bid);
        }
        q.evidenceIds = uploaded;
        q.evidenceBlobIds = [];
        await queue.put(q);
      }
      const res = await fetch(`/api/o/${orgSlug}/field/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mutations: all.map((q) => ({ deliveryId: q.deliveryId, to: q.to, version: q.version, reason: q.reason ?? null, note: q.note ?? null, receivedByName: q.receivedByName ?? null, scheduledFor: q.scheduledFor ?? null, lat: q.lat ?? null, lng: q.lng ?? null, evidenceIds: q.evidenceIds ?? [], clientMutationId: q.clientMutationId, occurredAt: q.occurredAt, source: "FIELD_OFFLINE" })),
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      let conflicts = 0;
      for (const r of json.data as { clientMutationId: string; ok: boolean; conflict?: { status: string }; error?: string }[]) {
        if (r.ok || r.conflict) {
          await queue.remove(r.clientMutationId);
          if (r.conflict) { conflicts++; toast.warning(interpolate(f.conflict, { status: m.enums.deliveryStatus[r.conflict.status as keyof typeof m.enums.deliveryStatus] })); }
        } else {
          const q = all.find((x) => x.clientMutationId === r.clientMutationId);
          // a permanently invalid mutation (e.g. invalid transition) is dropped after surfacing it
          if (q && r.error && r.error !== "errors.unexpected") { await queue.remove(q.clientMutationId); toast.error(tk(r.error)); }
          else if (q) { q.lastError = r.error; await queue.put(q); }
        }
      }
      if (!conflicts) toast.success(f.synced, { duration: 1500 });
    } catch (e) {
      toast.error(tk((e as Error).message || "errors.unexpected"));
    } finally {
      flushing.current = false;
      setSyncing(false);
      await refreshQueue();
      await load();
    }
  }, [orgSlug, refreshQueue, load, f, m, tk]);

  useEffect(() => {
    // replay anything queued before a reload / while offline, then load fresh state
    // (state is set after the IndexedDB read resolves — this effect syncs with an external store)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshQueue().then(() => (navigator.onLine ? flush() : load()));
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    const on = () => flush();
    window.addEventListener("online", on);
    const id = setInterval(() => { if (navigator.onLine) flush(); }, 30_000);
    return () => { window.removeEventListener("online", on); clearInterval(id); };
  }, [load, refreshQueue, flush]);

  /** Records a status change locally (optimistic) and queues it; flushes immediately when online. */
  const record = async (d: FieldDelivery, to: string, extra: Partial<QueuedMutation> & { photo?: File | null }) => {
    const id = crypto.randomUUID();
    const already = pending.some((p) => p.deliveryId === d.id);
    let evidenceBlobIds: string[] = [];
    if (extra.photo) {
      const bid = crypto.randomUUID();
      await blobs.put(bid, extra.photo, extra.photo.name || "proof.jpg");
      evidenceBlobIds = [bid];
    }
    const { photo: _p, ...rest } = extra;
    // Persist first: the update survives the app being closed or reloaded right away.
    const mutation: QueuedMutation = { clientMutationId: id, orgSlug, deliveryId: d.id, to, version: already ? undefined : d.version, occurredAt: new Date().toISOString(), createdAt: Date.now(), evidenceBlobIds, lat: null, lng: null, ...rest };
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
      if (coords && (await queue.all()).some((q) => q.clientMutationId === id)) await queue.put({ ...mutation, lat: coords.lat, lng: coords.lng });
    }
    if (navigator.onLine) flush();
  };

  // in-progress first, then assigned, rescheduled, failed (by priority within each)
  const ORDER: Record<string, number> = { OUT_FOR_DELIVERY: 0, ASSIGNED: 1, RESCHEDULED: 2, FAILED_ATTEMPT: 3 };
  const PRI: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const active = useMemo(() => (items?.filter((d) => ACTIVE.includes(d.status)) ?? []).sort((a, b) => ORDER[a.status] - ORDER[b.status] || PRI[a.priority] - PRI[b.priority]), [items]);
  const done = useMemo(() => items?.filter((d) => !ACTIVE.includes(d.status)) ?? [], [items]);
  const current = items?.find((d) => d.id === openId) ?? null;
  const Chevron = locale === "ar" ? ChevronLeft : ChevronRight;

  return (
    <div className="mx-auto max-w-lg">
      <header className="sticky top-0 z-20 border-b bg-primary px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 text-primary-foreground">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-xs opacity-80">{orgName}</div>
            <h1 className="truncate text-lg font-semibold">{f.title}</h1>
          </div>
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" className="text-primary-foreground hover:bg-white/10" onClick={() => (online ? flush() : load())} aria-label={f.syncNow}><RefreshCw className={cn(syncing && "animate-spin")} /></Button>
            <Button size="icon-sm" variant="ghost" className="text-primary-foreground hover:bg-white/10" onClick={() => { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* */ } logoutAction(); }} aria-label={f.signOut}><LogOut /></Button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className={cn("flex items-center gap-1 rounded-full px-2 py-0.5", online ? "bg-white/15" : "bg-warning text-black")} data-testid="field-online">
            {online ? <span className="size-1.5 rounded-full bg-emerald-300" /> : <CloudOff className="size-3" />}{online ? f.online : f.offline}
          </span>
          {pending.length > 0 && <span className="rounded-full bg-white/15 px-2 py-0.5" data-testid="field-pending">{interpolate(f.pending, { n: pending.length })}</span>}
          <span className="ms-auto truncate opacity-80">{agentName}</span>
        </div>
      </header>

      <p className="flex items-start gap-2 bg-warning-soft px-4 py-2 text-[11px] text-warning"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" />{f.privacy}</p>

      {items === null ? (
        <div className="grid gap-3 p-4">{[1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />)}</div>
      ) : (
        <main className="grid gap-5 p-4">
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Truck className="size-4" /> {f.active} <span className="tabular text-muted-foreground">({active.length})</span></h2>
            {active.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{f.empty}</p>}
            <ul className="grid gap-2.5">
              {active.map((d) => {
                const nav = navHref(d.recipient);
                const queued = pending.filter((p) => p.deliveryId === d.id).length;
                return (
                  <li key={d.id} className="surface overflow-hidden rounded-xl" data-testid="field-card" data-status={d.status}>
                    <button className="flex w-full items-start gap-3 p-3.5 text-start" onClick={() => setOpenId(d.id)}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={d.status} label={m.enums.deliveryStatus[d.status]} />
                          {d.priority === "CRITICAL" || d.priority === "HIGH" ? <StatusBadge status={d.priority} label={m.enums.priority[d.priority]} dot={false} /> : null}
                          {queued > 0 && <CloudOff className="size-3.5 text-warning" />}
                        </div>
                        <div className="mt-1.5 text-[15px] leading-snug font-semibold">{d.recipient.honorific} {d.recipient.name}</div>
                        <div className="text-xs text-muted-foreground">{d.recipient.organizationName}</div>
                        <div className="mt-1 flex items-center gap-1 text-xs"><MapPin className="size-3 text-muted-foreground" />{[d.recipient.city, d.recipient.district].filter(Boolean).join(" · ")}</div>
                        {d.recipient.preferredWindow && <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><Clock className="size-3" />{d.recipient.preferredWindow}</div>}
                      </div>
                      <Chevron className="mt-1 size-5 text-muted-foreground" />
                    </button>
                    <div className="grid grid-cols-3 border-t text-xs">
                      {nav ? <a href={nav} target="_blank" rel="noreferrer noopener" className="flex h-11 items-center justify-center gap-1.5 hover:bg-muted"><Navigation className="size-4 text-primary" />{m.delivery.navigate}</a> : <span className="flex h-11 items-center justify-center text-muted-foreground">—</span>}
                      {d.recipient.mobile && !d.recipient.masked ? <a href={telHref(d.recipient.mobile)} className="flex h-11 items-center justify-center gap-1.5 border-x hover:bg-muted"><Phone className="size-4 text-primary" />{m.delivery.call}</a> : <span className="border-x" />}
                      {d.recipient.mobile && !d.recipient.masked ? <a href={whatsappHref(d.recipient.mobile)} target="_blank" rel="noreferrer noopener" className="flex h-11 items-center justify-center gap-1.5 hover:bg-muted"><MessageCircle className="size-4 text-primary" />{m.delivery.whatsapp}</a> : <span />}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
          {done.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{f.completed} ({done.length})</h2>
              <ul className="grid gap-1.5">
                {done.map((d) => (
                  <li key={d.id} className="surface flex items-center gap-2 rounded-lg px-3 py-2 text-xs">
                    <StatusBadge status={d.status} label={m.enums.deliveryStatus[d.status]} />
                    <span className="min-w-0 flex-1 truncate">{d.recipient.name}</span>
                    {d.deliveredAt && <span className="tabular text-muted-foreground">{formatTime(d.deliveredAt, fmt)}</span>}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted-foreground">{f.hiddenAfter}</p>
            </section>
          )}
        </main>
      )}

      <Sheet open={!!current} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto rounded-t-2xl pb-[max(env(safe-area-inset-bottom),16px)]">
          {current && <DeliverySheet d={current} onRecord={record} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DeliverySheet({ d, onRecord }: { d: FieldDelivery; onRecord: (d: FieldDelivery, to: string, extra: Partial<QueuedMutation> & { photo?: File | null }) => Promise<void> }) {
  const { m, fmt } = useI18n();
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
    await onRecord(d, to, { note: note || null, ...extra });
    setBusy(false);
  };
  const deliveredReady = (!cfg.requireEvidence || !!photo) && (!cfg.requireReceiverName || receivedBy.trim().length > 1);
  return (
    <div className="grid gap-4">
      <SheetHeader className="p-0">
        <SheetTitle className="text-start text-lg">{r.honorific} {r.name}</SheetTitle>
        <div className="flex items-center gap-2"><StatusBadge status={d.status} label={m.enums.deliveryStatus[d.status]} /><span className="ltr-nums font-mono text-xs text-muted-foreground">{d.trackingCode}</span></div>
      </SheetHeader>
      <dl className="grid gap-2 rounded-xl bg-muted/50 p-3 text-sm">
        {r.organizationName && <div><dt className="text-[11px] text-muted-foreground">{m.projects.client}</dt><dd>{r.organizationName}</dd></div>}
        <div><dt className="text-[11px] text-muted-foreground">{m.common.address}</dt><dd>{r.address ?? "—"}<div className="text-xs text-muted-foreground">{[r.city, r.district].filter(Boolean).join(" · ")}</div></dd></div>
        {r.deliveryInstructions && <div><dt className="text-[11px] text-muted-foreground">{f.instructions}</dt><dd>{r.deliveryInstructions}</dd></div>}
        {r.mobile && <div><dt className="text-[11px] text-muted-foreground">{m.common.phone}</dt><dd className="ltr-nums">{r.mobile}</dd></div>}
        {d.scheduledFor && <div><dt className="text-[11px] text-muted-foreground">{m.delivery.scheduleFor}</dt><dd>{formatDateTime(d.scheduledFor, fmt)}</dd></div>}
        {d.attempts.length > 0 && <div><dt className="text-[11px] text-muted-foreground">{m.delivery.attempts}</dt><dd className="text-xs">{d.attempts.map((a) => `#${a.attemptNo} ${a.failureReason ? (m.delivery.reasons as Record<string, string>)[a.failureReason] : a.outcome}`).join(" · ")}</dd></div>}
      </dl>

      {(d.status === "ASSIGNED" || d.status === "RESCHEDULED" || d.status === "FAILED_ATTEMPT") && !mode && (
        <Button size="lg" className="h-14 text-base" disabled={busy} onClick={() => go("OUT_FOR_DELIVERY")} data-testid="field-start"><Truck /> {f.start}</Button>
      )}
      {d.status === "OUT_FOR_DELIVERY" && !mode && (
        <div className="grid grid-cols-2 gap-2">
          <Button size="lg" className="col-span-2 h-14 bg-success text-base text-white hover:bg-success/90" onClick={() => setMode("DELIVERED")} data-testid="field-delivered"><CheckCircle2 /> {f.markDelivered}</Button>
          <Button size="lg" variant="outline" className="h-12" onClick={() => setMode("FAILED_ATTEMPT")} data-testid="field-failed"><XCircle className="text-danger" /> {f.markFailed}</Button>
          <Button size="lg" variant="outline" className="h-12" onClick={() => setMode("RESCHEDULED")}><RotateCcw /> {f.reschedule}</Button>
          <Button size="lg" variant="ghost" className="col-span-2 h-10" onClick={() => setMode("RETURNED")}><Undo2 /> {f.return}</Button>
        </div>
      )}
      {d.status === "FAILED_ATTEMPT" && !mode && <Button variant="ghost" onClick={() => setMode("RETURNED")}><Undo2 /> {f.return}</Button>}

      {mode && (
        <div className="grid gap-3 rounded-xl border p-3">
          {mode === "DELIVERED" && (
            <>
              <label className={cn("flex h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed text-sm", photo && "border-success bg-success-soft text-success")}>
                <Camera className="size-6" />
                {photo ? f.photoAdded : f.takePhoto}
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} data-testid="field-photo" />
              </label>
              <Input placeholder={m.delivery.receivedBy} value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} className="h-12 text-base" data-testid="field-received-by" />
            </>
          )}
          {(mode === "FAILED_ATTEMPT" || mode === "RETURNED") && (
            <NativeSelect className="h-12 text-base" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="field-reason">
              <option value="">{m.delivery.failureReason}…</option>
              {FAILURE_REASONS.map((x) => <option key={x} value={x}>{m.delivery.reasons[x]}</option>)}
            </NativeSelect>
          )}
          {mode === "RESCHEDULED" && <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="h-12 text-base" dir="ltr" />}
          <Textarea placeholder={m.common.notes} value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
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
