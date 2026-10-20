"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, Section } from "@/components/app/page";
import { NativeSelect } from "@/components/app/field";
import { TimeAgo } from "@/components/app/time-ago";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { markReadAction, savePreferenceAction } from "@/app/actions/shell";

interface Item { id: string; type: string; title: string; body: string | null; link: string | null; readAt: Date | null; createdAt: Date }
interface Pref { type: string; inApp: boolean; email: boolean; digest: string }

/** Notification center + per-type preferences. `linkFor` maps a stored relative link into this surface. */
export function NotificationsView({ orgSlug, items, prefs, types, base }: { orgSlug: string; items: Item[]; prefs: Pref[]; types: { type: string; key: string }[]; base: "o" | "portal" | "vendor" }) {
  const { m, tk } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const shown = filter === "unread" ? items.filter((i) => !i.readAt) : items;
  const href = (link: string | null) => {
    if (base === "o") return link ? `/o/${orgSlug}${link}` : null;
    const proj = link?.match(/^\/projects\/([^/?#]+)/)?.[1];
    return base === "portal" && proj ? `/portal/${orgSlug}/projects/${proj}` : `/${base}/${orgSlug}`;
  };
  const pref = (type: string) => prefs.find((p) => p.type === type) ?? prefs.find((p) => p.type === "*") ?? { type, inApp: true, email: false, digest: "none" };
  const setPref = (type: string, patch: Partial<Pref>) => start(async () => { await savePreferenceAction(orgSlug, { ...pref(type), type, ...patch } as never); router.refresh(); });
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Section
        title={m.notif.title}
        actions={
          <div className="flex items-center gap-2">
            <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value as never)} className="h-8 text-xs"><option value="all">{m.notif.allTypes}</option><option value="unread">{m.notif.unread}</option></NativeSelect>
            {items.some((i) => !i.readAt) && <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { await markReadAction(orgSlug, {}); router.refresh(); })}>{m.shell.markAllRead}</Button>}
          </div>
        }
      >
        {shown.length === 0 ? <EmptyState title={m.shell.noNotifications} /> : (
          <ul className="divide-y">
            {shown.map((n) => {
              const params = n.body ? (JSON.parse(n.body) as Record<string, string>) : undefined;
              const to = href(n.link);
              const inner = (
                <>
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-primary")} />
                  <span className="min-w-0 flex-1"><span className="block text-[13px]">{tk(n.title, params)}</span><span className="text-[11px] text-muted-foreground"><TimeAgo date={n.createdAt} /></span></span>
                </>
              );
              return (
                <li key={n.id} className={cn(!n.readAt && "bg-brand-soft/30")} data-testid="notification">
                  {to ? <Link href={to} onClick={() => !n.readAt && markReadAction(orgSlug, { ids: [n.id] })} className="flex gap-3 px-4 py-3 hover:bg-muted/40">{inner}</Link> : <div className="flex gap-3 px-4 py-3">{inner}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section title={m.notif.preferences}>
        <table className="w-full text-xs">
          <thead className="border-b text-[11px] text-muted-foreground"><tr><th className="px-3 py-2 text-start font-medium" /><th className="px-2 py-2 font-medium">{m.notif.inApp}</th><th className="px-2 py-2 font-medium">{m.notif.emailChannel}</th></tr></thead>
          <tbody className="divide-y">
            {[{ type: "*", key: "notif.allTypes" }, ...types].map(({ type, key }) => {
              const p = pref(type);
              return (
                <tr key={type}>
                  <td className="px-3 py-2">{tk(key, { title: "…", name: "…", count: "…", code: "…" })}</td>
                  <td className="px-2 py-2 text-center"><input type="checkbox" checked={p.inApp} disabled={pending} onChange={(e) => setPref(type, { inApp: e.target.checked })} aria-label={m.notif.inApp} /></td>
                  <td className="px-2 py-2 text-center"><input type="checkbox" checked={p.email} disabled={pending} onChange={(e) => setPref(type, { email: e.target.checked })} aria-label={m.notif.emailChannel} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
