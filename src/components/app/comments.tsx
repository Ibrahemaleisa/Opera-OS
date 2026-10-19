"use client";

import { useState } from "react";
import { Lock, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/hooks/use-action";
import { formatRelative } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { addCommentAction } from "@/app/o/[org]/projects/actions";

export interface CommentRow { id: string; body: string; visibility: string; createdAt: string | Date; author: { id: string; name: string; nameAr: string | null } }

export function CommentsThread({ orgSlug, projectId, entityType, entityId, comments, members, clientView, canPost = true }: { orgSlug: string; projectId: string; entityType: "TASK" | "PROJECT" | "DELIVERY" | "APPROVAL" | "BOOTH" | "INCIDENT" | "CHANGE_REQUEST"; entityId: string; comments: CommentRow[]; members: { id: string; name: string }[]; clientView?: boolean; canPost?: boolean }) {
  const { m, fmt, locale } = useI18n();
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"INTERNAL" | "CLIENT">(clientView ? "CLIENT" : "INTERNAL");
  const [mentions, setMentions] = useState<string[]>([]);
  const { run, pending } = useAction(addCommentAction, { orgSlug, success: false, onSuccess: () => { setBody(""); setMentions([]); } });
  const query = /@([^\s@]*)$/.exec(body)?.[1];
  const suggestions = query !== undefined ? members.filter((x) => x.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6) : [];
  return (
    <div>
      <ul className="grid gap-3 px-4 py-3">
        {comments.map((c) => (
          <li key={c.id} className={cn("rounded-md border px-3 py-2", c.visibility === "INTERNAL" ? "bg-warning-soft/30 border-warning/20" : "bg-card")}>
            <div className="mb-1 flex items-center gap-2 text-xs">
              <span className="font-medium">{(locale === "ar" ? c.author.nameAr : null) ?? c.author.name}</span>
              {c.visibility === "INTERNAL" ? <span className="flex items-center gap-0.5 text-[10px] text-warning"><Lock className="size-2.5" />{m.common.internal}</span> : <span className="text-[10px] text-info">{m.common.clientVisible}</span>}
              <span className="ms-auto text-[10px] text-muted-foreground">{formatRelative(c.createdAt, fmt)}</span>
            </div>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{c.body}</p>
          </li>
        ))}
        {comments.length === 0 && <li className="text-center text-xs text-muted-foreground">{m.common.emptyTitle}</li>}
      </ul>
      {canPost && (
        <form
          className="relative grid gap-2 border-t px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!body.trim()) return;
            run({ entityType, entityId, projectId, body, visibility, mentions });
          }}
        >
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={m.tasks.writeComment} rows={2} data-testid="comment-body" />
          {suggestions.length > 0 && (
            <ul className="absolute bottom-full z-10 mb-1 w-64 rounded-md border bg-popover p-1 shadow-md">
              {suggestions.map((s) => (
                <li key={s.id}>
                  <button type="button" className="w-full rounded px-2 py-1 text-start text-sm hover:bg-muted" onClick={() => { setBody((b) => b.replace(/@[^\s@]*$/, `@${s.name} `)); setMentions((xs) => [...new Set([...xs, s.id])]); }}>{s.name}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between gap-2">
            {!clientView ? (
              <div className="inline-flex rounded-md border p-0.5 text-xs">
                <button type="button" onClick={() => setVisibility("INTERNAL")} className={cn("rounded px-2 py-0.5", visibility === "INTERNAL" && "bg-warning-soft text-warning")}>{m.tasks.internalNote}</button>
                <button type="button" onClick={() => setVisibility("CLIENT")} className={cn("rounded px-2 py-0.5", visibility === "CLIENT" && "bg-info-soft text-info")}>{m.tasks.clientComment}</button>
              </div>
            ) : <span />}
            <Button type="submit" size="sm" disabled={pending || !body.trim()}><Send /> {m.tasks.send}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
