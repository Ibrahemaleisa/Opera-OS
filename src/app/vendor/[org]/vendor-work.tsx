"use client";

import { Button } from "@/components/ui/button";
import { Attachments, type AttachmentRow } from "@/components/app/attachments";
import { EmptyState } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formatDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { setWorkOrderStatusAction } from "@/app/o/[org]/vendors/actions";

interface WO { id: string; title: string; scope: string | null; status: string; dueAt: Date | null; rating: number | null; project: { code: string; name: string } | null; files: AttachmentRow[] }

const NEXT: Record<string, { to: "ACCEPTED" | "IN_PROGRESS" | "DELIVERED"; key: "accept" | "start" | "deliver" }> = { ISSUED: { to: "ACCEPTED", key: "accept" }, ACCEPTED: { to: "IN_PROGRESS", key: "start" }, IN_PROGRESS: { to: "DELIVERED", key: "deliver" } };

export function VendorWork({ orgSlug, workOrders }: { orgSlug: string; workOrders: WO[] }) {
  const { m, fmt } = useI18n();
  const t = m.vendors;
  const set = useAction(setWorkOrderStatusAction, { orgSlug });
  if (!workOrders.length) return <EmptyState title={t.noWork} />;
  return (
    <ul className="grid gap-3">
      {workOrders.map((w) => {
        const next = NEXT[w.status];
        return (
          <li key={w.id} className="grid gap-3 rounded-xl border bg-card p-4" data-testid="vendor-wo" data-status={w.status}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{w.title}</span>
              <StatusBadge status={w.status === "ACCEPTED_BY_AGENCY" ? "DONE" : w.status === "DELIVERED" ? "REVIEW" : "IN_PROGRESS"} label={t.woStatus[w.status as keyof typeof t.woStatus]} />
              {w.project && <span className="ltr-nums text-xs text-muted-foreground">{w.project.code} · {w.project.name}</span>}
              {w.dueAt && <span className="ltr-nums ms-auto text-xs text-muted-foreground">{t.due}: {formatDate(w.dueAt, fmt)}</span>}
            </div>
            {w.scope && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{w.scope}</p>}
            <Attachments orgSlug={orgSlug} entityType="WORK_ORDER" entityId={w.id} items={w.files} canUpload={["ACCEPTED", "IN_PROGRESS"].includes(w.status)} />
            {next && <div><Button size="sm" disabled={set.pending} onClick={() => set.run({ id: w.id, status: next.to })} data-testid="vendor-wo-next">{t[next.key]}</Button></div>}
          </li>
        );
      })}
    </ul>
  );
}
