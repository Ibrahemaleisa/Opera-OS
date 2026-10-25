"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, NativeSelect } from "@/components/app/field";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export function UploadImport({ orgSlug, projectId, campaigns, defaultCampaign }: { orgSlug: string; projectId: string; campaigns: { id: string; name: string }[]; defaultCampaign: string }) {
  const { m, tk } = useI18n();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [campaignId, setCampaignId] = useState(defaultCampaign);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("projectId", projectId);
    if (campaignId) fd.set("campaignId", campaignId);
    try {
      const res = await fetch(`/api/o/${orgSlug}/imports`, { method: "POST", body: fd });
      // a proxy or size-limit rejection may not be JSON
      const json = (await res.json().catch(() => ({ ok: false, error: res.status === 413 ? "errors.fileTooLarge" : "errors.unexpected" }))) as { ok: boolean; error?: string; data?: { batchId: string } };
      if (json.ok && json.data) router.push(`/o/${orgSlug}/projects/${projectId}/delivery/imports/${json.data.batchId}`);
      else toast.error(tk(json.error ?? "errors.unexpected"));
    } catch {
      // network failure: keep the chosen file so the user can retry
      toast.error(tk("common.net.unreachable"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-3 p-4">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); setFile(e.dataTransfer.files[0] ?? null); }}
        className={cn("flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors", drag ? "border-primary bg-brand-soft" : "hover:border-primary/50")}
      >
        <FileSpreadsheet className="size-8 text-muted-foreground" />
        <span className="text-sm font-medium">{file ? file.name : m.delivery.import.upload}</span>
        <span className="text-xs text-muted-foreground">{file ? `${Math.ceil(file.size / 1024)} KB` : m.delivery.import.dropHint}</span>
      </button>
      <input ref={input} type="file" accept=".xlsx,.csv" className="hidden" data-testid="import-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <Field label={m.delivery.import.targetCampaign}>
        <NativeSelect value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
          <option value="">{m.delivery.import.noCards}</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </NativeSelect>
      </Field>
      <Button onClick={submit} disabled={!file || busy} data-testid="import-upload"><Upload /> {busy ? m.common.loading : m.common.upload}</Button>
    </div>
  );
}
