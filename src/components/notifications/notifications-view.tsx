"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Section } from "@/components/app/page";
import { NativeSelect } from "@/components/app/field";
import { TimeAgo } from "@/components/app/time-ago";
import { useI18n } from "@/lib/i18n/client";
import { interpolate } from "@/lib/i18n/define";
import { cn } from "@/lib/utils";
import { markReadAction, savePreferenceAction } from "@/app/actions/shell";
import { EscalatedChip } from "./escalated-chip";

interface Item { id: string; type: string; title: string; body: string | null; link: string | null; readAt: Date | null; createdAt: Date; escalationLevel?: number; priority?: string }
interface Pref { type: string; inApp: boolean; email: boolean; digest: string }
interface TypeRow { type: string; key: string; mandatory?: boolean; email?: string }

/** Escalated means level 2 and above: someone above the owner was pulled in (BUSINESS_RULES §3.4). */
const ESCALATED_FROM = 2;

/**
 * Notification center + per-type preferences. `linkFor` maps a stored relative link into this surface.
 * Mandatory types (§3.2 "M") show locked; the e-mail column says when e-mail is only simulated.
 */
export function NotificationsView({ orgSlug, items, prefs, types, base, emailSimulated = false }: { orgSlug: string; items: Item[]; prefs: Pref[]; types: TypeRow[]; base: "o" | "portal" | "vendor"; emailSimulated?: boolean }) {
  const { m, tk } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<"all" | "unread" | "escalated">("all");
  const shown = filter === "unread" ? items.filter((i) => !i.readAt) : filter === "escalated" ? items.filter((i) => (i.escalationLevel ?? 0) >= ESCALATED_FROM) : items;
  const escalatedCount = items.filter((i) => (i.escalationLevel ?? 0) >= ESCALATED_FROM).length;
  const href = (link: string | null) => {
    if (base === "o") return link ? `/o/${orgSlug}${link}` : null;
    const proj = link?.match(/^\/projects\/([^/?#]+)/)?.[1];
    return base === "portal" && proj ? `/portal/${orgSlug}/projects/${proj}` : `/${base}/${orgSlug}`;
  };
  const optionalDefault = (t: TypeRow | undefined) => t?.email === "opt_on";
  const pref = (type: string) => {
    const def = types.find((t) => t.type === type);
    const global = prefs.find((p) => p.type === "*");
    return prefs.find((p) => p.type === type) ?? { type, inApp: global?.inApp ?? true, email: global?.email === false ? false : type === "*" ? true : optionalDefault(def), digest: "none" };
  };
  const setPref = (type: string, patch: Partial<Pref>) => start(async () => { await savePreferenceAction(orgSlug, { ...pref(type), type, ...patch } as never); router.refresh(); });
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Section
        title={m.notif.title}
        actions={
          <div className="flex items-center gap-2">
            <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value as never)} className="h-8 text-xs" aria-label={m.notif.title}>
              <option value="all">{m.notif.allTypes}</option>
              <option value="unread">{m.notif.unread}</option>
              {escalatedCount > 0 && <option value="escalated">{m.notif.escalated} ({escalatedCount})</option>}
            </NativeSelect>
            {items.some((i) => !i.readAt) && <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { await markReadAction(orgSlug, {}); router.refresh(); })}>{m.shell.markAllRead}</Button>}
          </div>
        }
      >
        {shown.length === 0 ? <EmptyState title={m.shell.noNotifications} /> : (
          <ul className="divide-y">
            {shown.map((n) => {
              const params = n.body ? (JSON.parse(n.body) as Record<string, string>) : undefined;
              const to = href(n.link);
              const level = n.escalationLevel ?? 0;
              const inner = (
                <>
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-primary")} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px]">{tk(n.title, params)}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      {level >= ESCALATED_FROM && <EscalatedChip level={level} label={m.notif.escalated} levelLabel={interpolate(m.notif.escalatedLevel, { n: level })} title={interpolate(m.notif.escalatedTip, { n: level })} />}
                      <TimeAgo date={n.createdAt} />
                    </span>
                  </span>
                </>
              );
              return (
                <li key={n.id} className={cn(!n.readAt && "bg-brand-soft/30")} data-testid="notification" data-escalation={level || undefined}>
                  {to ? <Link href={to} onClick={() => !n.readAt && markReadAction(orgSlug, { ids: [n.id] })} className="flex gap-3 px-4 py-3 hover:bg-muted/40">{inner}</Link> : <div className="flex gap-3 px-4 py-3">{inner}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section title={m.notif.preferences} description={emailSimulated ? m.notif.emailSimulatedHint : undefined}>
        <table className="w-full text-xs">
          <thead className="border-b text-[11px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-start font-medium" />
              <th className="px-2 py-2 font-medium">{m.notif.inApp}</th>
              <th className="px-2 py-2 font-medium">
                {m.notif.emailChannel}
                {emailSimulated && <span className="block font-normal text-violet" data-testid="email-simulated-pref">{m.notif.emailSimulated}</span>}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {[{ type: "*", key: "notif.allTypes", mandatory: false, email: "opt_on" } as TypeRow, ...types].map((row) => {
              const p = pref(row.type);
              const noEmail = row.email === "none" || row.email === "digest";
              return (
                <tr key={row.type}>
                  <td className="px-3 py-2">
                    {tk(row.key, { title: "…", name: "…", count: "…", code: "…", days: "…", owner: "…" })}
                    {row.mandatory && <span className="ms-1.5 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground" title={m.notif.mandatoryHint}><Lock className="size-2.5" aria-hidden />{m.notif.mandatory}</span>}
                  </td>
                  <td className="px-2 py-2 text-center">
                    <input type="checkbox" checked={row.mandatory ? true : p.inApp} disabled={pending || row.mandatory} onChange={(e) => setPref(row.type, { inApp: e.target.checked })} aria-label={m.notif.inApp} />
                  </td>
                  <td className="px-2 py-2 text-center">
                    {noEmail ? <span className="text-muted-foreground">—</span> : (
                      <input type="checkbox" checked={row.mandatory ? true : p.email} disabled={pending || row.mandatory} onChange={(e) => setPref(row.type, { email: e.target.checked })} aria-label={m.notif.emailChannel} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
