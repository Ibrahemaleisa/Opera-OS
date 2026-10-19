"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, CalendarDays, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ProgressBar, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { FormDialog } from "@/components/app/form-dialog";
import { useAction } from "@/hooks/use-action";
import { formatDateTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { createEventAction } from "@/app/o/[org]/events/actions";

interface E { id: string; name: string; phase: string; startsAt: Date; endsAt: Date; readiness: { ready: number; total: number }; openIncidents: number }

export function EventList({ orgSlug, projectId, events, canManage }: { orgSlug: string; projectId: string; events: E[]; canManage: boolean }) {
  const { m, fmt } = useI18n();
  const t = m.events;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const create = useAction(createEventAction, { orgSlug, onSuccess: (d) => router.push(`/o/${orgSlug}/projects/${projectId}/events/${d.id}`) });
  return (
    <>
      <Section title={`${t.title} (${events.length})`} actions={canManage && <Button size="sm" onClick={() => setOpen(true)}><Plus /> {t.newEvent}</Button>}>
        {events.length === 0 ? <EmptyState icon={<CalendarDays />} title={m.common.emptyTitle} /> : (
          <ul className="divide-y">
            {events.map((e) => (
              <li key={e.id}>
                <Link href={`/o/${orgSlug}/projects/${projectId}/events/${e.id}`} className="grid gap-2 px-4 py-3 hover:bg-muted/40 md:grid-cols-[1fr_120px_200px_100px] md:items-center" data-testid="event-link">
                  <div><div className="text-[13px] font-medium">{e.name}</div><div className="ltr-nums text-[11px] text-muted-foreground">{formatDateTime(e.startsAt, fmt)}</div></div>
                  <StatusBadge status={e.phase} label={m.enums.eventPhase[e.phase as keyof typeof m.enums.eventPhase]} />
                  <div><ProgressBar value={e.readiness.total ? (e.readiness.ready / e.readiness.total) * 100 : 0} /><div className="tabular mt-1 text-[11px] text-muted-foreground">{t.readiness}: {e.readiness.ready}/{e.readiness.total}</div></div>
                  <span className={`flex items-center gap-1 text-xs ${e.openIncidents ? "text-danger" : "text-muted-foreground"}`}><AlertTriangle className="size-3.5" /> {e.openIncidents}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t.newEvent}
        fields={[
          { name: "name", label: m.common.name, required: true, wide: true },
          { name: "startsAt", label: t.starts, type: "datetime", required: true },
          { name: "endsAt", label: t.ends, type: "datetime", required: true },
        ]}
        extra={{ projectId }}
        onSubmit={(v) => create.run(v as never)}
        pending={create.pending}
        errorFor={create.errorFor}
        submitLabel={m.common.create}
      />
    </>
  );
}
