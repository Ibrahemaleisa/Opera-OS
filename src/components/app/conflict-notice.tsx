"use client";

import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { ConflictDetails } from "@/server/errors";

/** One field that differs between the stored record ("theirs") and the user's form ("yours"). */
export interface ConflictRow {
  name: string;
  label: React.ReactNode;
  theirs: React.ReactNode;
  yours: React.ReactNode;
}

/** "Opera" for system and automation writes, otherwise the person from the audit trail. */
export function useConflictAuthor(conflict: ConflictDetails | null) {
  const { m, fmt } = useI18n();
  const by = conflict?.changedBy ?? null;
  const name = !by || by.name === "—" || by.name === "system" ? m.common.conflict.system : by.name;
  return { name, when: by ? formatRelative(by.at, fmt) : null };
}

/**
 * The edit-conflict notice (BUSINESS_RULES §6 CE rule 4, UX note 7): who saved first and when, the
 * user's input kept, and an expandable "theirs vs yours" comparison of the fields that differ, each
 * with "Use theirs". Pass `onSaveMine` / `onDiscardMine` to render the actions here (inline panels);
 * FormDialog puts them in its own footer instead.
 */
export function ConflictNotice({
  conflict,
  rows,
  onUseTheirs,
  onSaveMine,
  onDiscardMine,
  pending,
  className,
}: {
  conflict: ConflictDetails;
  rows: ConflictRow[];
  onUseTheirs?: (field: string) => void;
  onSaveMine?: () => void;
  onDiscardMine?: () => void;
  pending?: boolean;
  className?: string;
}) {
  const { m } = useI18n();
  const c = m.common.conflict;
  const { name, when } = useConflictAuthor(conflict);
  // one sentence and the two actions by default; the field-by-field comparison is opened on demand
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [conflict]);
  return (
    <div ref={ref} tabIndex={-1} role="alert" className={cn("rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-lilac", className)} data-testid="conflict-notice">
      <p className="flex items-start gap-2 text-warning">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{when ? interpolate(c.savedBy, { name, time: when }) : c.savedByUnknown}</span>
      </p>
      {rows.length > 0 ? (
        <>
          <button type="button" className="mt-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? c.hideCompare : c.compare} ({rows.length})
          </button>
          {open && (
            <div className="mt-2 overflow-hidden rounded-md border bg-card text-foreground" data-testid="conflict-compare">
              <div className="hidden grid-cols-[minmax(90px,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_auto] gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground sm:grid">
                <span>{c.field}</span>
                <span>{c.theirs}</span>
                <span>{c.yours}</span>
                <span className="sr-only">{c.useTheirs}</span>
              </div>
              <ul className="divide-y">
                {rows.map((r) => (
                  <li key={r.name} className="grid gap-1 px-3 py-2 text-[13px] sm:grid-cols-[minmax(90px,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_auto] sm:items-center sm:gap-2" data-testid={`conflict-row-${r.name}`}>
                    <span className="text-xs font-medium text-muted-foreground">{r.label}</span>
                    <span className="min-w-0 break-words">
                      <span className="me-1 text-[11px] text-muted-foreground sm:hidden">{c.theirs}:</span>
                      <bdi>{r.theirs}</bdi>
                    </span>
                    <span className="min-w-0 break-words">
                      <span className="me-1 text-[11px] text-muted-foreground sm:hidden">{c.yours}:</span>
                      <bdi>{r.yours}</bdi>
                    </span>
                    {onUseTheirs ? (
                      <Button type="button" variant="ghost" size="sm" className="justify-self-start text-xs" onClick={() => onUseTheirs(r.name)} data-testid={`conflict-use-theirs-${r.name}`}>
                        {c.useTheirs}
                      </Button>
                    ) : <span />}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">{c.noDifferences}</p>
      )}
      {(onSaveMine || onDiscardMine) && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {onSaveMine && <Button type="button" size="sm" disabled={pending} onClick={onSaveMine} data-testid="conflict-save-mine">{c.saveMine}</Button>}
          {onDiscardMine && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onDiscardMine} data-testid="conflict-discard-mine">{c.discardMine}</Button>}
        </div>
      )}
    </div>
  );
}

/**
 * Inline-panel variant for a single field (UX note 7): "‹name› changed this to «value» · Keep mine ·
 * Use theirs", shown under the field that conflicted; the other fields are untouched.
 */
export function ConflictFieldNote({ conflict, value, onKeepMine, onUseTheirs }: { conflict: ConflictDetails; value: React.ReactNode; onKeepMine: () => void; onUseTheirs: () => void }) {
  const { m } = useI18n();
  const c = m.common.conflict;
  const { name } = useConflictAuthor(conflict);
  return (
    <p role="alert" className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-warning" data-testid="conflict-field-note">
      <span>{interpolate(c.changedTo, { name })} <bdi className="font-medium">«{value}»</bdi></span>
      <span aria-hidden>·</span>
      <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={onKeepMine}>{c.keepMine}</button>
      <span aria-hidden>·</span>
      <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={onUseTheirs}>{c.useTheirs}</button>
    </p>
  );
}

/** Field-level state for inline panels: whether a field conflicted and the value stored now. */
export function conflictValue(conflict: ConflictDetails | null, field: string): { conflicted: boolean; theirs: unknown } {
  if (!conflict) return { conflicted: false, theirs: undefined };
  return { conflicted: conflict.changedFields.includes(field), theirs: conflict.current[field] };
}
