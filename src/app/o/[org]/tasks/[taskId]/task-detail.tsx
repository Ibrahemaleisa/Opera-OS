"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertCircle, Lock, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Attachments } from "@/components/app/attachments";
import { CommentsThread } from "@/components/app/comments";
import { Field, NativeSelect } from "@/components/app/field";
import { Breadcrumbs, KV, ProgressBar, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formatDateTime, formatRelative, parseRiyadhDate, toDateInput } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { TimeAgo } from "@/components/app/time-ago";
import type { getTaskDetail } from "@/server/modules/tasks/service";
import {
  addChecklistItemAction, addDependencyAction, changeTaskStatusAction, createTaskAction, decideApprovalAction,
  removeDependencyAction, requestApprovalAction, setCollaboratorsAction, toggleChecklistItemAction, updateTaskAction,
} from "../../projects/actions";

type Detail = Awaited<ReturnType<typeof getTaskDetail>>;

export function TaskDetail({ orgSlug, data }: { orgSlug: string; data: Detail }) {
  const { m, fmt, locale, dir } = useI18n();
  const t = data.task;
  const nameOf = (id: string | null) => data.members.find((x) => x.id === id)?.name ?? "—";
  const update = useAction(updateTaskAction, { orgSlug });
  const status = useAction(changeTaskStatusAction, { orgSlug });
  const collab = useAction(setCollaboratorsAction, { orgSlug });
  const addItem = useAction(addChecklistItemAction, { orgSlug, success: false });
  const toggle = useAction(toggleChecklistItemAction, { orgSlug, success: false });
  const addDep = useAction(addDependencyAction, { orgSlug });
  const rmDep = useAction(removeDependencyAction, { orgSlug });
  const addSub = useAction(createTaskAction, { orgSlug, success: false });
  const [newItem, setNewItem] = useState("");
  const [newSub, setNewSub] = useState("");
  const [approvalOpen, setApprovalOpen] = useState(false);
  const ro = !data.canEdit;
  const projectName = (locale === "en" && t.project.nameEn) || t.project.name;
  const items = t.checklists.flatMap((c) => c.items);
  const overdue = t.statusCategory !== "DONE" && t.dueAt && new Date(t.dueAt) < new Date();
  const patch = (k: string, v: unknown) => update.run({ id: t.id, version: t.version, [k]: v } as never);

  return (
    <div className="grid gap-4">
      <Breadcrumbs dir={dir} items={[{ label: m.projects.title, href: `/o/${orgSlug}/projects` }, { label: projectName, href: `/o/${orgSlug}/projects/${t.project.id}/tasks` }, ...(t.parent ? [{ label: `#${t.parent.number}`, href: `/o/${orgSlug}/tasks/${t.parent.id}` }] : []), { label: `#${t.number}` }]} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="ltr-nums font-mono text-xs text-muted-foreground">{t.project.code}-{t.number}{data.workstream && <span className="ms-2 font-sans">· {data.workstream.name}</span>}</div>
          {ro ? <h1 className="page-title mt-1">{t.title}</h1> : (
            <input defaultValue={t.title} onBlur={(e) => e.target.value !== t.title && patch("title", e.target.value)} className="page-title mt-1 w-full rounded bg-transparent px-1 -mx-1 hover:bg-muted/50 focus:bg-card focus:outline-none" aria-label={m.common.title} />
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {t.escalatedAt && <span className="flex items-center gap-1 text-xs text-danger"><AlertCircle className="size-3.5" />{m.tasks.escalated}</span>}
            {t.dependencies.some((d) => !["DONE", "CANCELLED"].includes(d.dependsOn.statusCategory)) && <span className="flex items-center gap-1 text-xs text-warning"><Lock className="size-3.5" />{m.tasks.blockedBy}</span>}
            {t.requiresApproval && <StatusBadge status="REVIEW" label={m.projects.requiresApproval} />}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <NativeSelect className="h-9 w-44" value={t.status} disabled={status.pending || (ro && t.ownerId === null)} onChange={(e) => status.run({ id: t.id, status: e.target.value, version: t.version })} aria-label={m.common.status} data-testid="task-status">
            {data.statuses.map((s) => <option key={s.key} value={s.key}>{locale === "en" ? s.en : s.ar}</option>)}
          </NativeSelect>
          {!data.scope.clientView && data.canEdit && <Button variant="outline" size="sm" onClick={() => setApprovalOpen(true)}>{m.tasks.requestApproval}</Button>}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid content-start gap-4">
          <Section title={m.common.description}>
            <div className="p-3">
              {ro ? <p className="text-sm whitespace-pre-wrap">{t.description || "—"}</p> : <Textarea defaultValue={t.description ?? ""} rows={4} onBlur={(e) => e.target.value !== (t.description ?? "") && patch("description", e.target.value || null)} />}
            </div>
          </Section>

          <Section title={`${m.tasks.checklist}${items.length ? ` (${items.filter((i) => i.done).length}/${items.length})` : ""}`}>
            {items.length > 0 && <ProgressBar value={(items.filter((i) => i.done).length / items.length) * 100} className="rounded-none" />}
            <ul className="px-4 py-2">
              {items.map((i) => (
                <li key={i.id} className="flex items-center gap-2 py-1">
                  <Checkbox checked={i.done} onCheckedChange={(v) => toggle.run({ itemId: i.id, done: !!v })} disabled={ro && t.ownerId === null} />
                  <span className={`text-[13px] ${i.done ? "text-muted-foreground line-through" : ""}`}>{i.label}</span>
                </li>
              ))}
            </ul>
            {!ro && (
              <form className="flex gap-2 border-t px-4 py-2" onSubmit={(e) => { e.preventDefault(); if (newItem.trim()) addItem.run({ taskId: t.id, label: newItem }).then(() => setNewItem("")); }}>
                <Input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder={m.tasks.addItem} className="h-8" />
                <Button size="sm" variant="outline" type="submit"><Plus /></Button>
              </form>
            )}
          </Section>

          <Section title={`${m.tasks.subtasks} (${t.subtasks.length})`}>
            <ul className="divide-y">
              {t.subtasks.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-4 py-2 text-[13px]">
                  <StatusBadge status={s.statusCategory} label={m.enums.statusCategory[s.statusCategory]} />
                  <Link href={`/o/${orgSlug}/tasks/${s.id}`} className="hover:text-primary">#{s.number} {s.title}</Link>
                </li>
              ))}
            </ul>
            {!ro && (
              <form className="flex gap-2 border-t px-4 py-2" onSubmit={(e) => { e.preventDefault(); if (newSub.trim()) addSub.run({ projectId: t.project.id, parentId: t.id, workstreamId: t.workstreamId, title: newSub, priority: "MEDIUM", requiresApproval: false, clientVisible: false, tags: [] }).then(() => setNewSub("")); }}>
                <Input value={newSub} onChange={(e) => setNewSub(e.target.value)} placeholder={m.tasks.addSubtask} className="h-8" />
                <Button size="sm" variant="outline" type="submit"><Plus /></Button>
              </form>
            )}
          </Section>

          {!data.scope.clientView && (
            <Section title={m.tasks.dependencies}>
              <ul className="divide-y">
                {t.dependencies.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 px-4 py-2 text-[13px]">
                    <StatusBadge status={d.dependsOn.statusCategory} label={m.enums.statusCategory[d.dependsOn.statusCategory]} />
                    <Link href={`/o/${orgSlug}/tasks/${d.dependsOn.id}`} className="flex-1 hover:text-primary">#{d.dependsOn.number} {d.dependsOn.title}</Link>
                    {!ro && <Button variant="ghost" size="icon-xs" onClick={() => rmDep.run({ taskId: t.id, dependsOnId: d.dependsOn.id })} aria-label={m.common.remove}><X /></Button>}
                  </li>
                ))}
                {t.dependents.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 px-4 py-2 text-[13px] text-muted-foreground">
                    <span className="text-[11px]">{m.tasks.dependents}:</span>
                    <Link href={`/o/${orgSlug}/tasks/${d.task.id}`} className="hover:text-primary">#{d.task.number} {d.task.title}</Link>
                  </li>
                ))}
              </ul>
              {!ro && (
                <div className="border-t px-4 py-2">
                  <NativeSelect className="h-8" value="" onChange={(e) => e.target.value && addDep.run({ taskId: t.id, dependsOnId: e.target.value })} aria-label={m.tasks.addDependency}>
                    <option value="">+ {m.tasks.addDependency}</option>
                    {data.projectTasks.filter((x) => !t.dependencies.some((d) => d.dependsOn.id === x.id)).map((x) => <option key={x.id} value={x.id}>#{x.number} {x.title}</option>)}
                  </NativeSelect>
                </div>
              )}
            </Section>
          )}

          <Section title={m.common.attachments}>
            <Attachments orgSlug={orgSlug} entityType="TASK" entityId={t.id} items={data.attachments} canUpload={!data.scope.clientView && (data.canEdit || t.ownerId !== null)} allowClientVisible />
          </Section>

          <Section title={m.tasks.comments}>
            <CommentsThread orgSlug={orgSlug} projectId={t.project.id} entityType="TASK" entityId={t.id} comments={data.comments} members={data.members} clientView={data.scope.clientView} />
          </Section>
        </div>

        <div className="grid content-start gap-4">
          <Section title={m.common.details}>
            <div className="grid gap-3 p-4">
              <Field label={m.common.assignee}>
                <NativeSelect value={t.ownerId ?? ""} disabled={ro} onChange={(e) => patch("ownerId", e.target.value || null)}>
                  <option value="">{m.common.unassigned}</option>
                  {data.members.filter((x) => !["CLIENT_VIEWER", "CLIENT_APPROVER"].includes(x.role)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </NativeSelect>
              </Field>
              <Field label={m.common.priority}>
                <NativeSelect value={t.priority} disabled={ro} onChange={(e) => patch("priority", e.target.value)}>{Object.entries(m.enums.priority).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={m.common.startDate}><Input type="date" disabled={ro} defaultValue={toDateInput(t.startAt)} onChange={(e) => patch("startAt", parseRiyadhDate(e.target.value))} dir="ltr" /></Field>
                <Field label={m.common.dueDate} error={overdue ? m.common.overdue : undefined}><Input type="date" disabled={ro} defaultValue={toDateInput(t.dueAt)} onChange={(e) => patch("dueAt", parseRiyadhDate(e.target.value, "17:00"))} dir="ltr" /></Field>
                <Field label={m.tasks.estimate}><Input type="number" min={0} disabled={ro} defaultValue={t.estimateMinutes ?? ""} onBlur={(e) => patch("estimateMinutes", e.target.value ? Number(e.target.value) : null)} dir="ltr" /></Field>
                <Field label={m.tasks.actual}><Input type="number" min={0} disabled={ro && t.ownerId === null} defaultValue={t.actualMinutes ?? ""} onBlur={(e) => patch("actualMinutes", e.target.value ? Number(e.target.value) : null)} dir="ltr" /></Field>
                <Field label={m.tasks.sla}><Input type="number" min={1} disabled={ro} defaultValue={t.slaHours ?? ""} onBlur={(e) => patch("slaHours", e.target.value ? Number(e.target.value) : null)} dir="ltr" /></Field>
              </div>
              <Field label={m.tasks.tags}><Input disabled={ro} defaultValue={t.tags.join(", ")} onBlur={(e) => patch("tags", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} /></Field>
              {!data.scope.clientView && <label className="flex items-center gap-2 text-sm"><Checkbox disabled={ro} checked={t.clientVisible} onCheckedChange={(v) => patch("clientVisible", !!v)} /> {m.common.clientVisible}</label>}
              {!data.scope.clientView && <label className="flex items-center gap-2 text-sm"><Checkbox disabled={ro} checked={t.requiresApproval} onCheckedChange={(v) => patch("requiresApproval", !!v)} /> {m.projects.requiresApproval}</label>}
            </div>
          </Section>

          {!data.scope.clientView && (
            <Section title={m.tasks.collaborators}>
              <div className="flex flex-wrap gap-1.5 p-3">
                {data.members.filter((x) => !["CLIENT_VIEWER", "CLIENT_APPROVER"].includes(x.role)).map((x) => {
                  const on = t.collaborators.some((c) => c.userId === x.id);
                  return (
                    <button key={x.id} disabled={ro || collab.pending} onClick={() => collab.run({ taskId: t.id, userIds: on ? t.collaborators.filter((c) => c.userId !== x.id).map((c) => c.userId) : [...t.collaborators.map((c) => c.userId), x.id] })} className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-primary bg-jade-soft text-primary" : "text-muted-foreground"}`}>
                      {x.name}
                    </button>
                  );
                })}
              </div>
            </Section>
          )}

          <ApprovalsBox orgSlug={orgSlug} approvals={data.approvals} canDecide={data.scope.approve} nameOf={nameOf} />

          {!data.scope.clientView && (
            <Section title={m.common.history}>
              <ul className="max-h-80 divide-y overflow-y-auto">
                {data.history.map((h) => (
                  <li key={h.id} className="px-4 py-2 text-xs"><span className="text-muted-foreground">{m.tasks.reassignHistory}:</span> {nameOf(h.fromUserId)} → {nameOf(h.toUserId)} <span className="block text-[10px] text-muted-foreground"><TimeAgo date={h.createdAt} /></span></li>
                ))}
                {data.auditTrail.map((a) => (
                  <li key={a.id} className="px-4 py-2 text-xs"><span className="font-medium">{a.actorName}</span> <span className="ltr-nums font-mono text-muted-foreground">{a.action}</span>{a.summary && <span className="block truncate text-muted-foreground">{a.summary}</span>}<span className="block text-[10px] text-muted-foreground">{formatDateTime(a.createdAt, fmt)}</span></li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
      {approvalOpen && <RequestApprovalDialog orgSlug={orgSlug} projectId={t.project.id} entityId={t.id} title={t.title} members={data.members} onClose={() => setApprovalOpen(false)} />}
    </div>
  );
}

export function ApprovalsBox({ orgSlug, approvals, canDecide, nameOf }: { orgSlug: string; approvals: Detail["approvals"]; canDecide: boolean; nameOf: (id: string | null) => string }) {
  const { m, fmt } = useI18n();
  const decide = useAction(decideApprovalAction, { orgSlug });
  const [comment, setComment] = useState("");
  if (!approvals.length) return null;
  return (
    <Section title={m.projects.approvals}>
      <ul className="divide-y">
        {approvals.map((a) => (
          <li key={a.id} className="grid gap-2 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-medium">{a.title}</span>
              <StatusBadge status={a.status} label={m.enums.approvalStatus[a.status]} />
            </div>
            <ol className="grid gap-1 border-s ps-3 text-[11px] text-muted-foreground">
              {a.decisions.map((d) => (
                <li key={d.id}><span className="text-foreground">{nameOf(d.actorId)}</span> · {m.enums.approvalStatus[d.decision]}{d.comment && <span> — “{d.comment}”</span>} · <TimeAgo date={d.createdAt} /></li>
              ))}
            </ol>
            {a.status === "PENDING" && canDecide && (
              <div className="grid gap-2">
                <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={m.tasks.decisionComment} rows={2} />
                <div className="flex gap-2">
                  <Button size="sm" disabled={decide.pending} onClick={() => decide.run({ approvalId: a.id, decision: "APPROVED", comment: comment || null })}>{m.tasks.approve}</Button>
                  <Button size="sm" variant="outline" disabled={decide.pending || !comment.trim()} title={m.tasks.rejectNeedsComment} onClick={() => decide.run({ approvalId: a.id, decision: "REJECTED", comment })}>{m.tasks.reject}</Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function RequestApprovalDialog({ orgSlug, projectId, entityId, title, members, onClose }: { orgSlug: string; projectId: string; entityId: string; title: string; members: { id: string; name: string; role: string }[]; onClose: () => void }) {
  const { m } = useI18n();
  const [type, setType] = useState<"INTERNAL" | "CLIENT">("INTERNAL");
  const { run, pending } = useAction(requestApprovalAction, { orgSlug, onSuccess: onClose });
  const candidates = members.filter((x) => (type === "CLIENT" ? x.role === "CLIENT_APPROVER" : !["CLIENT_VIEWER", "CLIENT_APPROVER", "VENDOR", "FIELD_AGENT"].includes(x.role)));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{m.tasks.requestApproval}</DialogTitle></DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); run({ projectId, entityType: "TASK", entityId, title: String(fd.get("title")), description: (fd.get("description") as string) || null, approverType: type, approverUserId: (fd.get("approverUserId") as string) || null }); }}>
          <Field label={m.common.title}><Input name="title" defaultValue={title} required /></Field>
          <Field label={m.tasks.approverType}>
            <NativeSelect value={type} onChange={(e) => setType(e.target.value as never)}><option value="INTERNAL">{m.tasks.internalApproval}</option><option value="CLIENT">{m.tasks.clientApproval}</option></NativeSelect>
          </Field>
          <Field label={m.tasks.approver}><NativeSelect name="approverUserId"><option value="">{m.common.all}</option>{candidates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</NativeSelect></Field>
          <Field label={m.common.description}><Textarea name="description" rows={2} /></Field>
          <DialogFooter><Button type="submit" disabled={pending}>{m.tasks.requestApproval}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
