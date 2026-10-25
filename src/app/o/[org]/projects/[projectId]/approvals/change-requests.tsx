"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/app/action-button";
import { Textarea } from "@/components/ui/textarea";
import { Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { TimeAgo } from "@/components/app/time-ago";
import { useAction } from "@/hooks/use-action";
import { useI18n } from "@/lib/i18n/client";
import { respondChangeRequestAction } from "@/app/portal/[org]/actions";

interface Row { id: string; title: string; description: string; status: string; response: string | null; requestedBy: string; createdAt: Date }

export function ChangeRequests({ orgSlug, rows, canRespond }: { orgSlug: string; rows: Row[]; canRespond: boolean }) {
  const { m } = useI18n();
  const t = m.portal;
  const [text, setText] = useState<Record<string, string>>({});
  const respond = useAction(respondChangeRequestAction, { orgSlug });
  return (
    <Section title={`${t.clientRequests} (${rows.length})`}>
      <ul className="divide-y">
        {rows.map((r) => (
          <li key={r.id} className="grid gap-2 px-4 py-3" data-testid="agency-change-request">
            <div className="flex flex-wrap items-center gap-2"><span className="flex-1 text-[13px] font-medium">{r.title}</span><span className="text-[11px] text-muted-foreground">{r.requestedBy} · <TimeAgo date={r.createdAt} /></span><StatusBadge status={r.status === "ACCEPTED" ? "APPROVED" : r.status === "DECLINED" ? "REJECTED" : r.status === "UNDER_REVIEW" ? "REVIEW" : "OPEN"} label={t.requestStatus[r.status as keyof typeof t.requestStatus]} /></div>
            <p className="text-xs whitespace-pre-wrap text-muted-foreground">{r.description}</p>
            {r.response && <p className="rounded bg-muted px-2 py-1 text-xs">{t.response}: {r.response}</p>}
            {canRespond && ["OPEN", "UNDER_REVIEW"].includes(r.status) && (
              <div className="grid gap-2">
                <Textarea rows={2} value={text[r.id] ?? ""} onChange={(e) => setText((x) => ({ ...x, [r.id]: e.target.value }))} placeholder={t.response} />
                <div className="flex gap-2">
                  {r.status === "OPEN" && <ActionButton size="xs" variant="outline" disabled={respond.pending} action={() => respond.run({ id: r.id, status: "UNDER_REVIEW", response: text[r.id] || null })}>{t.review}</ActionButton>}
                  <Button size="xs" disabled={!text[r.id]?.trim() || respond.pending} onClick={() => respond.run({ id: r.id, status: "ACCEPTED", response: text[r.id] })}>{t.accept}</Button>
                  <Button size="xs" variant="ghost" disabled={!text[r.id]?.trim() || respond.pending} onClick={() => respond.run({ id: r.id, status: "DECLINED", response: text[r.id] })}>{t.decline}</Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
