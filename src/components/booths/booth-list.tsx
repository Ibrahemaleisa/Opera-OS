"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Hammer, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ProgressBar, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { FormDialog, enumOptions } from "@/components/app/form-dialog";
import { useAction } from "@/hooks/use-action";
import { formatDate, formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import type { listBooths } from "@/server/modules/booths/service";
import { saveBoothAction } from "@/app/o/[org]/booths/actions";

type D = Awaited<ReturnType<typeof listBooths>>;

export function BoothList({ orgSlug, projectId, data }: { orgSlug: string; projectId?: string; data: D }) {
  const { m, fmt } = useI18n();
  const t = m.booths;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const save = useAction(saveBoothAction, { orgSlug, onSuccess: (d) => router.push(`/o/${orgSlug}/projects/${projectId}/production/${d.id}`) });
  return (
    <>
      <Section title={`${t.title} (${data.booths.length})`} actions={data.canManage && projectId && <Button size="sm" onClick={() => setOpen(true)}><Plus /> {t.newBooth}</Button>}>
        {data.booths.length === 0 ? <EmptyState icon={<Hammer />} title={m.common.emptyTitle} /> : (
          <ul className="divide-y">
            {data.booths.map((b) => (
              <li key={b.id}>
                <Link href={`/o/${orgSlug}/projects/${b.projectId}/production/${b.id}`} className="grid gap-2 px-4 py-3 hover:bg-muted/40 md:grid-cols-[1fr_200px_150px_130px_80px] md:items-center" data-testid="booth-link">
                  <div><div className="text-[13px] font-medium">{b.name}</div><div className="ltr-nums text-[11px] text-muted-foreground">{b.project.code} · {t.kind[b.kind as keyof typeof t.kind]}{b.standNumber ? ` · ${b.standNumber}` : ""}</div></div>
                  <div><ProgressBar value={((b.stageIndex + 1) / 12) * 100} /><div className="mt-1 text-[11px]"><StatusBadge status={b.stageIndex >= 8 ? "DONE" : "IN_PROGRESS"} label={m.enums.boothStage[b.stage]} /></div></div>
                  <span className="tabular text-xs">{formatMoney(b.estimate, { ...fmt, compact: true })}{b.actual > 0 && <span className="text-muted-foreground"> / {formatMoney(b.actual, { ...fmt, compact: true })}</span>}</span>
                  <span className="ltr-nums text-xs text-muted-foreground">{t.handover}: {b.handoverAt ? formatDate(b.handoverAt, fmt) : "—"}</span>
                  <span className={`text-xs ${b.openSnags ? "text-warning" : "text-muted-foreground"}`}>{t.openSnags}: {b.openSnags}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {projectId && (
        <FormDialog open={open} onOpenChange={setOpen} title={t.newBooth} fields={[{ name: "name", label: m.common.name, required: true, wide: true }, { name: "kind", label: m.common.type, type: "select", options: enumOptions(t.kind) }, { name: "standNumber", label: t.stand, ltr: true }, { name: "exhibition", label: t.exhibition }, { name: "hall", label: t.hall }]} values={{ kind: "BOOTH" }} extra={{ projectId, permitStatus: "NOT_STARTED" }} onSubmit={(v) => save.run(v as never)} pending={save.pending} errorFor={save.errorFor} submitLabel={m.common.create} />
      )}
    </>
  );
}
