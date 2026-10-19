"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FileText, ImageIcon, Paperclip, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { TimeAgo } from "@/components/app/time-ago";
import { fileUrlAction } from "@/app/o/[org]/projects/actions";

export interface AttachmentRow { id: string; fileName: string; mimeType: string; size: number; version: number; createdAt: string | Date; clientVisible: boolean; kind?: string }

export async function uploadFile(orgSlug: string, form: { file: File; entityType: string; entityId: string; kind?: string; clientVisible?: boolean; previousId?: string }) {
  const fd = new FormData();
  fd.set("file", form.file);
  fd.set("entityType", form.entityType);
  fd.set("entityId", form.entityId);
  if (form.kind) fd.set("kind", form.kind);
  if (form.clientVisible) fd.set("clientVisible", "true");
  if (form.previousId) fd.set("previousId", form.previousId);
  const res = await fetch(`/api/o/${orgSlug}/upload`, { method: "POST", body: fd });
  return (await res.json()) as { ok: boolean; error?: string; data?: { id: string } };
}

export function Attachments({ orgSlug, entityType, entityId, items, canUpload, allowClientVisible }: { orgSlug: string; entityType: string; entityId: string; items: AttachmentRow[]; canUpload: boolean; allowClientVisible?: boolean }) {
  const { m, tk, fmt } = useI18n();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [clientVisible, setClientVisible] = useState(false);
  const open = async (id: string) => {
    const r = await fileUrlAction(orgSlug, { attachmentId: id });
    if (r.ok) window.open(r.data, "_blank", "noopener");
    else toast.error(tk(r.error));
  };
  return (
    <div>
      <ul className="divide-y">
        {items.map((a) => (
          <li key={a.id} className="flex items-center gap-2 px-4 py-2">
            {a.mimeType.startsWith("image/") ? <ImageIcon className="size-4 text-muted-foreground" /> : <FileText className="size-4 text-muted-foreground" />}
            <button className="min-w-0 flex-1 truncate text-start text-[13px] hover:text-primary" onClick={() => open(a.id)}>{a.fileName}</button>
            {a.version > 1 && <span className="text-[10px] text-muted-foreground">v{a.version}</span>}
            {a.clientVisible && <span className="rounded bg-info-soft px-1 text-[9px] text-info">{m.common.clientVisible}</span>}
            <span className="tabular text-[11px] text-muted-foreground">{Math.ceil(a.size / 1024)} KB · <TimeAgo date={a.createdAt} /></span>
          </li>
        ))}
        {items.length === 0 && <li className="px-4 py-4 text-center text-xs text-muted-foreground"><Paperclip className="mx-auto mb-1 size-4" />{m.common.emptyTitle}</li>}
      </ul>
      {canUpload && (
        <div className="flex items-center gap-3 border-t px-4 py-2">
          <input
            ref={input}
            type="file"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setBusy(true);
              const r = await uploadFile(orgSlug, { file, entityType, entityId, clientVisible });
              setBusy(false);
              e.target.value = "";
              if (r.ok) { toast.success(m.common.saved); router.refresh(); } else toast.error(tk(r.error ?? "errors.unexpected"));
            }}
          />
          <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}><Upload /> {busy ? m.tasks.uploading : m.tasks.upload}</Button>
          {allowClientVisible && <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={clientVisible} onChange={(e) => setClientVisible(e.target.checked)} /> {m.common.clientVisible}</label>}
        </div>
      )}
    </div>
  );
}
