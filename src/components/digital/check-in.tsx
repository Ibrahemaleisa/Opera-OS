"use client";

import { useState } from "react";
import { CheckCircle2, ScanLine, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageBody } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { formatTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { checkInAction } from "@/app/o/[org]/digital/actions";

export function CheckInDesk({ orgSlug, campaignId, name, total, checkedIn }: { orgSlug: string; campaignId: string; name: string; total: number; checkedIn: number }) {
  const { m, fmt } = useI18n();
  const [code, setCode] = useState("");
  const [last, setLast] = useState<{ ok: boolean; text: string } | null>(null);
  const [count, setCount] = useState(checkedIn);
  const act = useAction(checkInAction, {
    orgSlug,
    success: false,
    refresh: false,
    onSuccess: (r) => {
      const who = `${r.recipient?.honorific ?? ""} ${r.recipient?.nameAr ?? r.recipient?.nameEn ?? ""}`.trim();
      setLast({ ok: !r.already, text: `${r.already ? m.digital.already : m.digital.checkInOk}: ${who} · ${formatTime(r.checkedInAt, fmt)}` });
      if (!r.already) setCount((c) => c + 1);
      setCode("");
    },
  });
  return (
    <PageBody className="max-w-lg">
      <h1 className="page-title">{m.digital.checkInDesk}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{name} · <span className="tabular">{count}/{total}</span> {m.digital.checkedIn}</p>
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (code.trim()) act.run({ campaignId, code }); }}>
        <div className="relative">
          <ScanLine className="absolute start-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder={m.digital.scanHint} className="ltr-nums h-14 ps-11 font-mono text-lg" dir="ltr" />
        </div>
        <Button type="submit" className="h-12" disabled={act.pending}>{m.common.confirm}</Button>
      </form>
      {last && <div className={`mt-4 flex items-center gap-2 rounded-lg p-4 text-sm ${last.ok ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>{last.ok ? <CheckCircle2 /> : <XCircle />}{last.text}</div>}
    </PageBody>
  );
}
