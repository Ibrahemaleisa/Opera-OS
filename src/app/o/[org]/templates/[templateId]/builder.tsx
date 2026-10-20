"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect } from "@/components/app/field";
import { Section } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { formatDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { TaskDef, TemplateDefinition } from "@/server/modules/templates/definition";
import { GanttRows } from "../../projects/portfolio-views";
import { publishVersionAction } from "../actions";

interface Version { id: string; version: number; changelog: string | null; createdAt: string; definition: unknown }

const KINDS = ["GENERAL", "VIP_DELIVERY", "DIGITAL_INVITES", "EVENT_OPS", "CONFERENCE", "PROTOCOL", "BOOTH", "PAVILION"] as const;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `k${Date.now().toString(36)}`;

function blankTask(n: number): TaskDef {
  return { key: `task-${n}`, title: { ar: "مهمة جديدة", en: "New task" }, priority: "MEDIUM", anchor: "start", offsetDays: 0, durationDays: 1, requiresApproval: false, clientVisible: false, checklist: [], subtasks: [], dependsOn: [], tags: [] };
}

export function TemplateBuilder({ orgSlug, templateId, versions, usage }: { orgSlug: string; templateId: string; versions: Version[]; usage: { version: number; count: number }[] }) {
  const { m, locale, fmt } = useI18n();
  const latest = versions[0];
  const [def, setDef] = useState<TemplateDefinition>(() => structuredClone(latest.definition as TemplateDefinition));
  const [mode, setMode] = useState<"visual" | "json">("visual");
  const [json, setJson] = useState(() => JSON.stringify(latest.definition, null, 2));
  const [changelog, setChangelog] = useState("");
  const [wsIndex, setWsIndex] = useState(0);
  const publish = useAction(publishVersionAction, { orgSlug, success: m.templates.published });
  const t = (x: { ar: string; en: string }) => (locale === "ar" ? x.ar : x.en);
  const allTaskKeys = def.workstreams.flatMap((w) => w.tasks.map((tk) => tk.key));
  const ws = def.workstreams[wsIndex];

  const mutate = (fn: (d: TemplateDefinition) => void) => setDef((d) => { const c = structuredClone(d); fn(c); return c; });
  const setTask = (i: number, patch: Partial<TaskDef>) => mutate((d) => { d.workstreams[wsIndex].tasks[i] = { ...d.workstreams[wsIndex].tasks[i], ...patch }; });

  // preview with a sample event date 30 days from today
  const [now] = useState(() => Date.now());
  const preview = useMemo(() => {
    const start = now;
    const anchors = { start, event: start + 30 * 86400_000, deadline: start + 32 * 86400_000 };
    return def.workstreams.flatMap((w) =>
      w.tasks.map((tk) => {
        const s = anchors[tk.anchor] + tk.offsetDays * 86400_000;
        return { id: `${w.key}:${tk.key}`, label: t(tk.title), sub: t(w.name), start: new Date(s), end: new Date(s + Math.max(tk.durationDays, 0.3) * 86400_000), tone: tk.requiresApproval ? ("warning" as const) : ("brand" as const) };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, locale]);

  const doPublish = () => {
    let definition: unknown = def;
    if (mode === "json") {
      try { definition = JSON.parse(json); } catch { definition = "__invalid__"; }
    }
    publish.run({ templateId, definition, changelog: changelog || null });
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border bg-card p-0.5">
          {(["visual", "json"] as const).map((k) => (
            <button key={k} onClick={() => { if (k === "json") setJson(JSON.stringify(def, null, 2)); else { try { setDef(JSON.parse(json)); } catch { /* keep */ } } setMode(k); }} className={cn("h-7 rounded px-3 text-xs", mode === k && "bg-secondary font-medium")}>
              {k === "visual" ? m.templates.visual : m.templates.json}
            </button>
          ))}
        </div>
        <Input value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder={m.templates.changelog} className="h-8 max-w-xs" />
        <Button size="sm" onClick={doPublish} disabled={publish.pending}>{m.templates.publish} (v{latest.version + 1})</Button>
        {publish.fieldErrors.definition && <ul className="w-full text-xs text-danger">{publish.fieldErrors.definition.slice(0, 6).map((e) => <li key={e} className="ltr-nums">{e}</li>)}</ul>}
      </div>

      {mode === "json" ? (
        <Section title={m.templates.definition} description={m.templates.definitionHint}>
          <Textarea value={json} onChange={(e) => setJson(e.target.value)} className="min-h-[60vh] rounded-none border-0 font-mono text-xs" dir="ltr" spellCheck={false} />
        </Section>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <Section title={m.projects.workstreams} actions={<Button variant="ghost" size="icon-xs" aria-label={m.templates.addWorkstream} onClick={() => { mutate((d) => d.workstreams.push({ key: `ws-${d.workstreams.length + 1}`, name: { ar: "مسار جديد", en: "New workstream" }, kind: "GENERAL", tasks: [] })); setWsIndex(def.workstreams.length); }}><Plus /></Button>}>
            <ul className="p-1">
              {def.workstreams.map((w, i) => (
                <li key={w.key + i}>
                  <button onClick={() => setWsIndex(i)} className={cn("w-full rounded-md px-2 py-1.5 text-start text-[13px]", i === wsIndex ? "bg-brand-soft text-primary" : "hover:bg-muted")}>
                    {t(w.name)} <span className="text-[11px] text-muted-foreground">({w.tasks.length})</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
          {ws ? (
            <div className="grid content-start gap-4">
              <Section title={t(ws.name)} actions={def.workstreams.length > 1 && <Button variant="ghost" size="icon-xs" onClick={() => { mutate((d) => d.workstreams.splice(wsIndex, 1)); setWsIndex(0); }} aria-label={m.common.delete}><Trash2 /></Button>}>
                <div className="grid gap-3 p-4 sm:grid-cols-4">
                  <Field label={m.common.nameAr}><Input value={ws.name.ar} onChange={(e) => mutate((d) => { d.workstreams[wsIndex].name.ar = e.target.value; })} /></Field>
                  <Field label={m.common.nameEn}><Input value={ws.name.en} dir="ltr" onChange={(e) => mutate((d) => { d.workstreams[wsIndex].name.en = e.target.value; })} /></Field>
                  <Field label={m.templates.key}><Input value={ws.key} dir="ltr" onChange={(e) => mutate((d) => { d.workstreams[wsIndex].key = slug(e.target.value); })} /></Field>
                  <Field label={m.common.type}><NativeSelect value={ws.kind} onChange={(e) => mutate((d) => { d.workstreams[wsIndex].kind = e.target.value as never; })}>{KINDS.map((k) => <option key={k} value={k}>{m.enums.workstreamKind[k]}</option>)}</NativeSelect></Field>
                </div>
              </Section>
              <Section title={m.projects.tasks} actions={<Button size="xs" variant="ghost" onClick={() => mutate((d) => { d.workstreams[wsIndex].tasks.push(blankTask(allTaskKeys.length + 1)); })}><Plus /> {m.templates.addTask}</Button>}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[980px] text-[12.5px]">
                    <thead className="bg-muted/60 text-[11px] text-muted-foreground">
                      <tr className="border-b">
                        {["", m.common.nameAr, m.common.nameEn, m.templates.anchor, m.templates.offset, m.templates.duration, m.common.priority, m.tasks.dependencies, m.projects.requiresApproval, m.common.clientVisible, ""].map((h, i) => <th key={i} className="h-8 px-2 text-start font-medium">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {ws.tasks.map((tk, i) => (
                        <tr key={i} className="border-b align-top last:border-0">
                          <td className="px-1 py-1.5">
                            <div className="flex flex-col">
                              <button disabled={i === 0} onClick={() => mutate((d) => { const a = d.workstreams[wsIndex].tasks; [a[i - 1], a[i]] = [a[i], a[i - 1]]; })} className="text-muted-foreground disabled:opacity-20" aria-label="up"><ArrowUp className="size-3" /></button>
                              <button disabled={i === ws.tasks.length - 1} onClick={() => mutate((d) => { const a = d.workstreams[wsIndex].tasks; [a[i + 1], a[i]] = [a[i], a[i + 1]]; })} className="text-muted-foreground disabled:opacity-20" aria-label="down"><ArrowDown className="size-3" /></button>
                            </div>
                          </td>
                          <td className="px-1 py-1.5"><Input className="h-8" value={tk.title.ar} onChange={(e) => setTask(i, { title: { ...tk.title, ar: e.target.value } })} /></td>
                          <td className="px-1 py-1.5"><Input className="h-8" dir="ltr" value={tk.title.en} onChange={(e) => setTask(i, { title: { ...tk.title, en: e.target.value } })} /></td>
                          <td className="px-1 py-1.5"><NativeSelect className="h-8" value={tk.anchor} onChange={(e) => setTask(i, { anchor: e.target.value as never })}><option value="start">{m.templates.anchorStart}</option><option value="event">{m.templates.anchorEvent}</option><option value="deadline">{m.templates.anchorDeadline}</option></NativeSelect></td>
                          <td className="px-1 py-1.5"><Input className="h-8 w-20" type="number" dir="ltr" value={tk.offsetDays} onChange={(e) => setTask(i, { offsetDays: Number(e.target.value) })} /></td>
                          <td className="px-1 py-1.5"><Input className="h-8 w-16" type="number" min={0} dir="ltr" value={tk.durationDays} onChange={(e) => setTask(i, { durationDays: Number(e.target.value) })} /></td>
                          <td className="px-1 py-1.5"><NativeSelect className="h-8" value={tk.priority} onChange={(e) => setTask(i, { priority: e.target.value as never })}>{Object.entries(m.enums.priority).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></td>
                          <td className="px-1 py-1.5">
                            <select multiple className="h-16 w-40 rounded border bg-card text-[11px]" value={tk.dependsOn} onChange={(e) => setTask(i, { dependsOn: [...e.target.selectedOptions].map((o) => o.value) })}>
                              {allTaskKeys.filter((k) => k !== tk.key).map((k) => <option key={k} value={k}>{k}</option>)}
                            </select>
                          </td>
                          <td className="px-2 py-1.5 text-center"><Checkbox checked={tk.requiresApproval} onCheckedChange={(v) => setTask(i, { requiresApproval: !!v })} /></td>
                          <td className="px-2 py-1.5 text-center"><Checkbox checked={tk.clientVisible} onCheckedChange={(v) => setTask(i, { clientVisible: !!v })} /></td>
                          <td className="px-1 py-1.5"><Button variant="ghost" size="icon-xs" onClick={() => mutate((d) => { d.workstreams[wsIndex].tasks.splice(i, 1); d.workstreams.forEach((w) => w.tasks.forEach((x) => (x.dependsOn = x.dependsOn.filter((k) => k !== tk.key)))); })} aria-label={m.common.delete}><Trash2 /></Button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            </div>
          ) : null}
        </div>
      )}

      <Section title={m.templates.preview} description={formatDate(new Date(now + 30 * 86400_000), fmt)}>
        <GanttRows locale={locale} rows={preview} />
      </Section>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title={m.templates.versions}>
          <ul className="divide-y">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between px-4 py-2 text-[13px]">
                <span>v{v.version} <span className="text-xs text-muted-foreground">{v.changelog}</span></span>
                <span className="tabular text-xs text-muted-foreground">{formatDate(v.createdAt, fmt)}</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title={m.templates.usage}>
          <ul className="divide-y">
            {usage.length === 0 && <li className="px-4 py-3 text-xs text-muted-foreground">{m.common.none}</li>}
            {usage.map((u) => <li key={u.version} className="flex justify-between px-4 py-2 text-[13px]"><span>v{u.version}</span><span className="tabular">{u.count}</span></li>)}
          </ul>
        </Section>
      </div>
    </div>
  );
}
