"use client";

import { useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect } from "@/components/app/field";
import { EmptyState, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { ConfirmAction } from "@/components/app/confirm-action";
import { ConflictNotice, type ConflictRow } from "@/components/app/conflict-notice";
import { useAction } from "@/hooks/use-action";
import { formObject } from "@/lib/form";
import { formatDate, parseRiyadhDate, toDateInput } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { FormDialog, enumOptions, type FieldDef } from "@/components/app/form-dialog";
import { saveDeliverableAction, saveMilestoneAction, saveRiskAction, setIndependentApprovalAction, setProjectStatusAction, updateProjectAction } from "../actions";
import { moveKind, StatusImpactDialog } from "./status-dialog";
import type { LifecycleTarget } from "@/server/modules/projects/lifecycle";

const MS_STATUS = { PENDING: "PENDING", IN_PROGRESS: "IN_PROGRESS", BLOCKED: "BLOCKED", DONE: "DONE" } as const;

export interface StatusTarget { to: LifecycleTarget; reason: string; preview: boolean }

/**
 * The project status menu (BUSINESS_RULES §1.2): only the moves the caller may make from here.
 * Cancel, close, hold, complete, resume and reopen open the impact dialog; the rest are one click.
 * AT_RISK is never offered (health derives it).
 */
export function ProjectStatusMenu({ orgSlug, projectId, code, status, version, targets }: { orgSlug: string; projectId: string; code: string; status: string; version: number; targets: StatusTarget[] }) {
  const { m } = useI18n();
  const L = m.projects.lifecycle;
  const quick = useAction(setProjectStatusAction, { orgSlug });
  const [dialogTo, setDialogTo] = useState<LifecycleTarget | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!targets.length) return null;
  const label = (to: LifecycleTarget) => {
    const k = moveKind(status, to);
    if (k === "resume") return L.to.resume;
    if (k === "reopen") return L.to.reopen;
    if (status === "DRAFT" && to === "PLANNING") return L.to.commit;
    return L.to[to];
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button ref={triggerRef} variant="ghost" size="sm" disabled={quick.pending} data-testid="project-status-menu">{m.projects.changeStatus} <MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs">{m.projects.changeStatus}</DropdownMenuLabel>
          {targets.map((t) => (
            <DropdownMenuItem key={t.to} className={t.to === "CANCELLED" ? "text-danger" : undefined} onSelect={() => (t.preview ? setDialogTo(t.to) : quick.run({ id: projectId, status: t.to, version }))} data-testid={`project-status-${t.to}`}>
              {label(t.to)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogTo && <StatusImpactDialog key={dialogTo} orgSlug={orgSlug} projectId={projectId} code={code} from={status} target={dialogTo} onOpenChange={(o) => { if (!o) { setDialogTo(null); triggerRef.current?.focus(); } }} />}
    </>
  );
}

/**
 * The project's independent-approval flag (§4.2, AP rule 6): setting it needs project.delete;
 * clearing it needs the same plus a reason.
 */
export function IndependentApprovalControl({ orgSlug, projectId, value, version, canSet }: { orgSlug: string; projectId: string; value: boolean; version: number; canSet: boolean }) {
  const { m } = useI18n();
  const I = m.projects.lifecycle.independent;
  const set = useAction(setIndependentApprovalAction, { orgSlug });
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{value ? I.on : I.off}</span>
      {canSet && (
        <ConfirmAction
          trigger={<Button variant="link" size="xs" className="h-auto p-0 text-xs" data-testid="independent-approval-toggle">{value ? I.clear : I.set}</Button>}
          title={value ? I.clear : I.set}
          description={I.setDesc}
          confirmLabel={value ? I.clear : I.set}
          field={value ? { type: "textarea", label: I.clearReason, required: true } : undefined}
          onConfirm={(reason) => set.run({ projectId, value: !value, version, reason: reason || null })}
        />
      )}
    </span>
  );
}

const sameValue = (a: unknown, b: unknown) => {
  const n = (v: unknown) => (v === undefined || v === "" ? null : v instanceof Date ? v.toISOString() : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v).toISOString() : v);
  return JSON.stringify(n(a)) === JSON.stringify(n(b));
};

/**
 * CE rule 4 for the inline milestone / deliverable / risk dialogs: who saved first, theirs vs yours
 * for the fields that differ, "Save my version" (only the fields the user changed, on top of the
 * stored record, at its version) and "Discard mine" (load the stored record).
 */
function PanelConflict<T extends { version?: number }>({ save, loaded, labels, show, onDiscard }: {
  save: { conflict: import("@/server/errors").ConflictDetails | null; conflictInput: unknown; pending: boolean; run: (i: never) => unknown; clearConflict: () => void };
  loaded: T;
  labels: Record<string, string>;
  show: (field: string, v: unknown) => React.ReactNode;
  onDiscard: (stored: Record<string, unknown>) => void;
}) {
  const c = save.conflict;
  if (!c) return null;
  const mine = (save.conflictInput ?? {}) as Record<string, unknown>;
  const base = loaded as unknown as Record<string, unknown>;
  const rows: ConflictRow[] = c.changedFields.filter((f) => f in labels).map((f) => ({ name: f, label: labels[f], theirs: show(f, c.current[f]), yours: show(f, mine[f]) }));
  const saveMine = () => {
    const changedByMe = Object.keys(mine).filter((k) => k in labels && !sameValue(mine[k], base[k]));
    const payload: Record<string, unknown> = { ...mine };
    for (const k of Object.keys(labels)) if (!changedByMe.includes(k) && k in c.current) payload[k] = c.current[k];
    save.run({ ...payload, version: c.current.version } as never);
  };
  return <ConflictNotice conflict={c} rows={rows} pending={save.pending} onSaveMine={saveMine} onDiscardMine={() => { save.clearConflict(); onDiscard(c.current); }} />;
}

interface Milestone { id: string; title: string; dueDate: string | Date | null; status: string; clientVisible: boolean; workstreamId: string | null; version: number }

export function MilestonesPanel({ orgSlug, projectId, milestones, canEdit }: { orgSlug: string; projectId: string; milestones: Milestone[]; canEdit: boolean }) {
  const { m, fmt } = useI18n();
  const [edit, setEdit] = useState<Milestone | "new" | null>(null);
  const save = useAction(saveMilestoneAction, { orgSlug, conflictUi: "inline", onSuccess: () => setEdit(null) });
  const cur = edit && edit !== "new" ? edit : null;
  const statusLabel = (s: string) => ({ PENDING: m.enums.approvalStatus.PENDING, IN_PROGRESS: m.enums.statusCategory.ACTIVE, BLOCKED: m.enums.statusCategory.BLOCKED, DONE: m.enums.statusCategory.DONE })[s] ?? s;
  return (
    <Section title={m.projects.milestones} actions={canEdit && <Button variant="ghost" size="xs" onClick={() => setEdit("new")}><Plus /> {m.projects.newMilestone}</Button>}>
      {milestones.length === 0 ? <EmptyState title={m.common.emptyTitle} className="py-6" /> : (
        <ol className="relative ms-4 border-s py-2">
          {milestones.map((ms) => {
            const late = ms.status !== "DONE" && ms.dueDate && new Date(ms.dueDate) < new Date();
            return (
              <li key={ms.id} className="relative mb-1 ps-5 pe-4">
                <span className={`absolute -start-[5px] top-3 size-2.5 rounded-full border-2 border-card ${ms.status === "DONE" ? "bg-success" : ms.status === "BLOCKED" ? "bg-danger" : late ? "bg-warning" : "bg-muted-foreground/40"}`} />
                <button disabled={!canEdit} onClick={() => setEdit(ms)} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start hover:bg-muted/50">
                  <span className="text-[13px]">{ms.title}</span>
                  <span className="flex items-center gap-2">
                    <span className={`tabular text-xs ${late ? "text-danger" : "text-muted-foreground"}`}>{formatDate(ms.dueDate, fmt)}</span>
                    <StatusBadge status={ms.status === "IN_PROGRESS" ? "ACTIVE" : ms.status} label={statusLabel(ms.status)} />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <Dialog open={!!edit} onOpenChange={(o) => { if (!o) { setEdit(null); save.clearConflict(); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{cur?.title ?? m.projects.newMilestone}</DialogTitle></DialogHeader>
          {cur && <PanelConflict save={save} loaded={cur} labels={{ title: m.common.title, dueDate: m.common.dueDate, status: m.common.status, clientVisible: m.common.clientVisible }} show={(f, v) => (f === "dueDate" ? formatDate(v as string | null, fmt) : f === "status" ? statusLabel(String(v)) : f === "clientVisible" ? (v ? "✓" : "—") : String(v ?? "—"))} onDiscard={(s) => setEdit({ ...cur, ...(s as Partial<Milestone>) })} />}
          <form key={`${cur?.id}-${cur?.version}`} className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const o = formObject(e.currentTarget); save.run({ id: cur?.id, version: cur?.version, projectId, title: String(o.title), dueDate: parseRiyadhDate(o.dueDate as string), status: o.status as never, clientVisible: !!o.clientVisible, workstreamId: cur?.workstreamId ?? null }); }}>
            <Field label={m.common.title} required><Input name="title" defaultValue={cur?.title} required /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={m.common.dueDate}><Input type="date" name="dueDate" defaultValue={toDateInput(cur?.dueDate)} dir="ltr" /></Field>
              <Field label={m.common.status}><NativeSelect name="status" defaultValue={cur?.status ?? "PENDING"}>{Object.keys(MS_STATUS).map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</NativeSelect></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="clientVisible" defaultChecked={cur?.clientVisible ?? true} /> {m.common.clientVisible}</label>
            <DialogFooter><Button type="submit" disabled={save.pending}>{m.common.save}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

interface Deliverable { id: string; title: string; description: string | null; status: string; dueDate: string | Date | null; clientVisible: boolean; requiresApproval: boolean; workstreamId: string | null; version: number }

export function DeliverablesPanel({ orgSlug, projectId, deliverables, canEdit }: { orgSlug: string; projectId: string; deliverables: Deliverable[]; canEdit: boolean }) {
  const { m, fmt } = useI18n();
  const [edit, setEdit] = useState<Deliverable | "new" | null>(null);
  const save = useAction(saveDeliverableAction, { orgSlug, conflictUi: "inline", onSuccess: () => setEdit(null) });
  const cur = edit && edit !== "new" ? edit : null;
  const labels: Record<string, string> = { PENDING: m.enums.approvalStatus.PENDING, IN_PROGRESS: m.enums.statusCategory.ACTIVE, SUBMITTED: m.enums.revisionStatus.SUBMITTED, APPROVED: m.enums.approvalStatus.APPROVED, REJECTED: m.enums.approvalStatus.REJECTED };
  return (
    <Section title={m.projects.deliverables} actions={canEdit && <Button variant="ghost" size="xs" onClick={() => setEdit("new")}><Plus /> {m.projects.newDeliverable}</Button>}>
      {deliverables.length === 0 ? <EmptyState title={m.common.emptyTitle} className="py-6" /> : (
        <ul className="divide-y">
          {deliverables.map((d) => (
            <li key={d.id}>
              <button disabled={!canEdit} onClick={() => setEdit(d)} className="flex w-full items-center justify-between gap-2 px-4 py-2 text-start hover:bg-muted/40">
                <span className="text-[13px]">{d.title}{d.requiresApproval && <span className="ms-1 text-[10px] text-violet">· {m.projects.requiresApproval}</span>}</span>
                <span className="flex items-center gap-2"><span className="tabular text-xs text-muted-foreground">{formatDate(d.dueDate, fmt)}</span><StatusBadge status={d.status === "IN_PROGRESS" ? "ACTIVE" : d.status} label={labels[d.status] ?? d.status} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!edit} onOpenChange={(o) => { if (!o) { setEdit(null); save.clearConflict(); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{cur?.title ?? m.projects.newDeliverable}</DialogTitle></DialogHeader>
          {cur && <PanelConflict save={save} loaded={cur} labels={{ title: m.common.title, description: m.common.description, dueDate: m.common.dueDate, status: m.common.status, clientVisible: m.common.clientVisible, requiresApproval: m.projects.requiresApproval }} show={(f, v) => (f === "dueDate" ? formatDate(v as string | null, fmt) : f === "status" ? labels[String(v)] ?? String(v) : typeof v === "boolean" ? (v ? "✓" : "—") : String(v ?? "—"))} onDiscard={(s) => setEdit({ ...cur, ...(s as Partial<Deliverable>) })} />}
          <form key={`${cur?.id}-${cur?.version}`} className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const o = formObject(e.currentTarget); save.run({ id: cur?.id, version: cur?.version, projectId, title: String(o.title), description: (o.description as string) ?? null, dueDate: parseRiyadhDate(o.dueDate as string), status: o.status as never, clientVisible: !!o.clientVisible, requiresApproval: !!o.requiresApproval, workstreamId: cur?.workstreamId ?? null }); }}>
            <Field label={m.common.title} required><Input name="title" defaultValue={cur?.title} required /></Field>
            <Field label={m.common.description}><Textarea name="description" defaultValue={cur?.description ?? ""} rows={2} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={m.common.dueDate}><Input type="date" name="dueDate" defaultValue={toDateInput(cur?.dueDate)} dir="ltr" /></Field>
              <Field label={m.common.status} error={save.errorFor("_")}><NativeSelect name="status" defaultValue={cur?.status ?? "PENDING"}>{Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="clientVisible" defaultChecked={cur?.clientVisible ?? true} /> {m.common.clientVisible}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requiresApproval" defaultChecked={cur?.requiresApproval} /> {m.projects.requiresApproval}</label>
            <DialogFooter><Button type="submit" disabled={save.pending}>{m.common.save}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

interface Risk { id: string; title: string; description: string | null; likelihood: number; impact: number; status: string; ownerId: string | null; mitigation: string | null; version: number }

export function RisksPanel({ orgSlug, projectId, risks, canEdit, members }: { orgSlug: string; projectId: string; risks: Risk[]; canEdit: boolean; members: { id: string; name: string }[] }) {
  const { m } = useI18n();
  const [edit, setEdit] = useState<Risk | "new" | null>(null);
  const save = useAction(saveRiskAction, { orgSlug, conflictUi: "inline", onSuccess: () => setEdit(null) });
  const cur = edit && edit !== "new" ? edit : null;
  const statusLabels: Record<string, string> = { OPEN: m.enums.incidentStatus.OPEN, MITIGATING: m.enums.incidentStatus.IN_PROGRESS, CLOSED: m.enums.incidentStatus.CLOSED };
  return (
    <Section title={m.projects.risks} actions={canEdit && <Button variant="ghost" size="xs" onClick={() => setEdit("new")}><Plus /> {m.projects.newRisk}</Button>}>
      {risks.length === 0 ? <EmptyState title={m.common.emptyTitle} className="py-6" /> : (
        <ul className="divide-y">
          {risks.map((r) => {
            const score = r.likelihood * r.impact;
            return (
              <li key={r.id}>
                <button disabled={!canEdit} onClick={() => setEdit(r)} className="flex w-full items-center gap-3 px-4 py-2 text-start hover:bg-muted/40">
                  <span className={`tabular flex size-7 shrink-0 items-center justify-center rounded text-xs font-medium ${score >= 15 ? "bg-danger text-white" : score >= 8 ? "bg-warning-soft text-warning" : "bg-muted text-muted-foreground"}`}>{score}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{r.title}</span>{r.mitigation && <span className="block truncate text-[11px] text-muted-foreground">{r.mitigation}</span>}</span>
                  <StatusBadge status={r.status === "MITIGATING" ? "IN_PROGRESS" : r.status} label={statusLabels[r.status]} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={!!edit} onOpenChange={(o) => { if (!o) { setEdit(null); save.clearConflict(); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{cur?.title ?? m.projects.newRisk}</DialogTitle></DialogHeader>
          {cur && <PanelConflict save={save} loaded={cur} labels={{ title: m.common.title, description: m.common.description, likelihood: m.projects.likelihood, impact: m.projects.impact, status: m.common.status, ownerId: m.common.owner, mitigation: m.projects.mitigation }} show={(f, v) => (f === "status" ? statusLabels[String(v)] ?? String(v) : f === "ownerId" ? members.find((x) => x.id === v)?.name ?? m.common.unassigned : String(v ?? "—"))} onDiscard={(s) => setEdit({ ...cur, ...(s as Partial<Risk>) })} />}
          <form key={`${cur?.id}-${cur?.version}`} className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const o = formObject(e.currentTarget); save.run({ ...o, ownerId: o.ownerId || null, id: cur?.id, version: cur?.version, projectId } as never); }}>
            <Field label={m.common.title} required><Input name="title" defaultValue={cur?.title} required /></Field>
            <Field label={m.common.description}><Textarea name="description" defaultValue={cur?.description ?? ""} rows={2} /></Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label={m.projects.likelihood}><NativeSelect name="likelihood" defaultValue={cur?.likelihood ?? 2}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</NativeSelect></Field>
              <Field label={m.projects.impact}><NativeSelect name="impact" defaultValue={cur?.impact ?? 2}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</NativeSelect></Field>
              <Field label={m.common.status}><NativeSelect name="status" defaultValue={cur?.status ?? "OPEN"}>{Object.entries(statusLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Field>
            </div>
            <Field label={m.common.owner}><NativeSelect name="ownerId" defaultValue={cur?.ownerId ?? ""}><option value="">{m.common.unassigned}</option>{members.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</NativeSelect></Field>
            <Field label={m.projects.mitigation}><Textarea name="mitigation" defaultValue={cur?.mitigation ?? ""} rows={2} /></Field>
            <DialogFooter><Button type="submit" disabled={save.pending}>{m.common.save}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

interface EditableProject { id: string; version: number; name: string; nameEn: string | null; description: string | null; clientId: string | null; type: string; priority: string; contractRef: string | null; poReference: string | null; budgetAmount: string | number | null; currency: string; startDate: string | Date | null; deadline: string | Date | null; eventStartAt: string | Date | null; eventEndAt: string | Date | null; clientPortal: boolean; venueIds: string[] }

/** Edits project details; venues and manager are kept as they are. */
export function EditProjectButton({ orgSlug, project, clients, canFinance }: { orgSlug: string; project: EditableProject; clients: { id: string; name: string }[]; canFinance: boolean }) {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const save = useAction(updateProjectAction, { orgSlug, conflictUi: "inline", onSuccess: () => setOpen(false) });
  const fields: FieldDef[] = [
    { name: "name", label: m.common.nameAr, required: true, wide: true },
    { name: "nameEn", label: m.common.nameEn, ltr: true, wide: true },
    { name: "clientId", label: m.projects.client, type: "select", empty: "—", options: clients.map((c) => ({ value: c.id, label: c.name })) },
    { name: "priority", label: m.common.priority, type: "select", options: enumOptions(m.enums.priority) },
    { name: "contractRef", label: m.projects.contractRef, ltr: true },
    { name: "poReference", label: m.projects.poReference, ltr: true },
    ...(canFinance ? [{ name: "budgetAmount", label: m.projects.budget, type: "number" as const, min: 0 }] : []),
    { name: "startDate", label: m.common.startDate, type: "datetime" },
    { name: "deadline", label: m.projects.deadline, type: "datetime" },
    { name: "eventStartAt", label: m.projects.eventStart, type: "datetime" },
    { name: "eventEndAt", label: m.projects.eventEnd, type: "datetime" },
    { name: "clientPortal", label: m.projects.clientPortal, type: "checkbox", wide: true },
    { name: "description", label: m.common.description, type: "textarea" },
  ];
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} data-testid="edit-project">{m.common.edit}</Button>
      <FormDialog open={open} onOpenChange={setOpen} title={project.name} fields={fields} values={{ ...project, startDate: project.startDate && new Date(project.startDate), deadline: project.deadline && new Date(project.deadline), eventStartAt: project.eventStartAt && new Date(project.eventStartAt), eventEndAt: project.eventEndAt && new Date(project.eventEndAt) }} extra={{ id: project.id, version: project.version, type: project.type, currency: project.currency, venueIds: project.venueIds }} onSubmit={(v) => save.run(v as never)} pending={save.pending} errorFor={save.errorFor} conflict={save.conflict} onConflictResolved={save.clearConflict} testId="form-project" />
    </>
  );
}
