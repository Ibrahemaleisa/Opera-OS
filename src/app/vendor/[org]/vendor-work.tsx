"use client";

import { Attachments, type AttachmentRow } from "@/components/app/attachments";
import { EmptyState } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { useI18n } from "@/lib/i18n/client";
import { setWorkOrderStatusAction } from "@/app/o/[org]/vendors/actions";
import { DateText } from "@/components/app/date-text";
import { ActionButton } from "@/components/app/action-button";

interface WO { id: string; title: string; scope: string | null; status: string; dueAt: Date | null; rating: number | null; project: { code: string; name: string } | null; files: AttachmentRow[] }

const NEXT: Record<string, { to: "ACCEPTED" | "IN_PROGRESS" | "DELIVERED"; key: "accept" | "start" | "deliver" }> = { ISSUED: { to: "ACCEPTED", key: "accept" }, ACCEPTED: { to: "IN_PROGRESS", key: "start" }, IN_PROGRESS: { to: "DELIVERED", key: "deliver" } };

export function VendorWork({ orgSlug, workOrders }: { orgSlug: string; workOrders: WO[] }) {
  const { m } = useI18n();
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
              {w.project && <span className="text-xs text-muted-foreground"><span className="ltr-nums">{w.project.code}</span> · <bdi>{w.project.name}</bdi></span>}
              {w.dueAt && <span className="ms-auto text-xs text-muted-foreground">{t.due}: <DateText value={w.dueAt} /></span>}
            </div>
            {w.scope && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{w.scope}</p>}
            <Attachments orgSlug={orgSlug} entityType="WORK_ORDER" entityId={w.id} items={w.files} canUpload={["ACCEPTED", "IN_PROGRESS"].includes(w.status)} />
            {next && <div><ActionButton size="sm" action={() => set.run({ id: w.id, status: next.to })} data-testid="vendor-wo-next">{t[next.key]}</ActionButton></div>}
          </li>
        );
      })}
    </ul>
  );
}
