"use client";

import { useState } from "react";
import { FormDialog, enumOptions } from "@/components/app/form-dialog";
import { ProgressBar, Section } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { formatPercent } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { resourceBoard } from "@/server/modules/resources/service";
import { saveResourceProfileAction } from "./actions";

type D = Awaited<ReturnType<typeof resourceBoard>>;
type R = D["rows"][number];

export function ResourceBoard({ orgSlug, data }: { orgSlug: string; data: D }) {
  const { m, fmt } = useI18n();
  const t = m.resources;
  const [edit, setEdit] = useState<R | null>(null);
  const save = useAction(saveResourceProfileAction, { orgSlug, onSuccess: () => setEdit(null) });
  const list = (v: unknown) => (typeof v === "string" ? v.split(/[,،]/).map((x) => x.trim()).filter(Boolean) : []);
  return (
    <>
      <Section title={`${t.title} (${data.rows.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="border-b bg-muted/40 text-[11px] text-muted-foreground"><tr>{[m.common.name, t.kind.EMPLOYEE + " / " + t.kind.DRIVER, t.capacity, t.load, t.openTasks, t.dueThisWeek, t.shiftHours, t.activeDeliveries, t.territories].map((h, i) => <th key={i} className="px-3 py-2 text-start font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y">
              {data.rows.map((r) => {
                const over = (r.load ?? 0) > 1;
                return (
                  <tr key={r.userId} className={cn(data.canManage && "cursor-pointer hover:bg-muted/40", !r.active && "opacity-50")} onClick={() => data.canManage && setEdit(r)} data-testid="resource-row">
                    <td className="px-3 py-2"><div className="font-medium">{r.name}</div><div className="text-[11px] text-muted-foreground">{r.role}</div></td>
                    <td className="px-3 py-2 text-xs">{t.kind[r.kind as keyof typeof t.kind]}{r.vehicle ? ` · ${r.vehicle}` : ""}</td>
                    <td className="tabular px-3 py-2">{r.capacity}</td>
                    <td className="w-40 px-3 py-2"><ProgressBar value={Math.min(100, (r.load ?? 0) * 100)} tone={over ? "danger" : (r.load ?? 0) > 0.8 ? "warning" : "brand"} /><span className={cn("tabular text-[11px]", over ? "text-danger" : "text-muted-foreground")}>{formatPercent(r.load, fmt)}{over ? ` · ${t.overloaded}` : ""}</span></td>
                    <td className="tabular px-3 py-2">{r.openTasks}{r.overdue > 0 && <span className="ms-1 text-[11px] text-danger">({r.overdue} {t.overdue})</span>}</td>
                    <td className="tabular px-3 py-2">{r.dueThisWeek}</td>
                    <td className="tabular px-3 py-2">{r.shiftHours}</td>
                    <td className="tabular px-3 py-2">{r.activeDeliveries}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.territories.join("، ") || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
      {edit && (
        <FormDialog
          open
          onOpenChange={(o) => !o && setEdit(null)}
          title={edit.name}
          fields={[
            { name: "kind", label: m.common.type, type: "select", options: enumOptions(t.kind) },
            { name: "dailyCapacity", label: t.capacity, type: "number", min: 0, hint: t.capacityHint, required: true },
            { name: "skills", label: t.skills, hint: t.commaHint, wide: true },
            { name: "territories", label: t.territories, hint: t.commaHint, wide: true },
            { name: "vehicle", label: t.vehicle },
            { name: "active", label: t.active, type: "checkbox" },
          ]}
          values={{ ...edit, dailyCapacity: edit.capacity, skills: edit.skills.join(", "), territories: edit.territories.join(", ") }}
          onSubmit={(v) => save.run({ ...v, userId: edit.userId, skills: list(v.skills), territories: list(v.territories) } as never)}
          pending={save.pending}
          errorFor={save.errorFor}
        />
      )}
    </>
  );
}
