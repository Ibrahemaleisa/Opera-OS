"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Check, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect } from "@/components/app/field";
import { Section } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { formatDate, parseRiyadhDate, parseRiyadhDateTime } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { PROJECT_TYPES } from "@/server/modules/projects/schemas";
import { createProjectAction } from "../actions";

interface Tpl { id: string; key: string; name: string; description: string; category: string; isSystem: boolean; latestVersion: number; stats: { workstreams: number; tasks: number; milestones: number; subtasks: number } | null }

const SUGGEST: Record<string, string[]> = {
  CONFERENCE: ["conference", "vip-physical-delivery"],
  EVENT: ["corporate-event"],
  EXHIBITION: ["exhibition"],
  VIP_DELIVERY: ["vip-physical-delivery"],
  PROTOCOL: ["vip-protocol"],
  BOOTH: ["booth-production"],
  PAVILION: ["pavilion-production"],
  CUSTOM: ["custom-blank"],
};

export function ProjectWizard({ orgSlug, clients, venues, managers, currentUserId, templates }: { orgSlug: string; clients: { id: string; name: string }[]; venues: { id: string; name: string; city: string }[]; managers: { id: string; name: string }[]; currentUserId: string; templates: Tpl[] }) {
  const { m, fmt } = useI18n();
  const w = m.projects.wizard;
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [data, setData] = useState({ name: "", nameEn: "", description: "", clientId: "", type: "CONFERENCE", priority: "MEDIUM", contractRef: "", budgetAmount: "", startDate: "", deadline: "", eventStartAt: "", eventEndAt: "", managerId: currentUserId, clientPortal: true });
  const [venueIds, setVenueIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>(() => templates.filter((t) => SUGGEST.CONFERENCE.includes(t.key)).map((t) => t.id));
  const { run, pending, errorFor } = useAction(createProjectAction, { orgSlug, success: m.common.success, refresh: false, onSuccess: (d) => router.push(`/o/${orgSlug}/projects/${d.id}`) });
  const set = (k: keyof typeof data) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setData((d) => ({ ...d, [k]: e.target.value }));
  const totals = useMemo(() => {
    const ts = templates.filter((t) => selected.includes(t.id));
    return { workstreams: ts.reduce((n, t) => n + (t.stats?.workstreams ?? 0), 0), tasks: ts.reduce((n, t) => n + (t.stats?.tasks ?? 0) + (t.stats?.subtasks ?? 0), 0), milestones: ts.reduce((n, t) => n + (t.stats?.milestones ?? 0), 0) };
  }, [selected, templates]);
  const steps = [w.step1, w.step2, w.step3, w.step4];
  const canNext = step === 0 ? data.name.trim().length >= 2 : true;

  const submit = () =>
    run({
      name: data.name, nameEn: data.nameEn || null, description: data.description || null, clientId: data.clientId || null, type: data.type as never, priority: data.priority as never,
      contractRef: data.contractRef || null, budgetAmount: data.budgetAmount ? Number(data.budgetAmount) : null, currency: "SAR",
      startDate: parseRiyadhDate(data.startDate), deadline: parseRiyadhDate(data.deadline, "23:59"), eventStartAt: parseRiyadhDateTime(data.eventStartAt), eventEndAt: parseRiyadhDateTime(data.eventEndAt),
      venueIds, managerId: data.managerId || null, clientPortal: data.clientPortal, templateIds: selected,
    });

  return (
    <div className="grid gap-4">
      <ol className="flex flex-wrap gap-2">
        {steps.map((s, i) => (
          <li key={s}>
            <button onClick={() => i < step && setStep(i)} className={cn("flex items-center gap-2 rounded-full border px-3 py-1 text-xs", i === step ? "border-primary bg-jade-soft text-primary" : i < step ? "text-foreground" : "text-muted-foreground")}>
              <span className={cn("flex size-4 items-center justify-center rounded-full text-[10px]", i < step ? "bg-primary text-primary-foreground" : "bg-muted")}>{i < step ? <Check className="size-3" /> : i + 1}</span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Section>
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label={m.common.nameAr} error={errorFor("name")} required className="sm:col-span-2"><Input value={data.name} onChange={set("name")} autoFocus data-testid="project-name" /></Field>
            <Field label={m.common.nameEn}><Input value={data.nameEn} onChange={set("nameEn")} dir="ltr" /></Field>
            <Field label={m.projects.client}>
              <NativeSelect value={data.clientId} onChange={set("clientId")}><option value="">{m.projects.noClient}</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect>
            </Field>
            <Field label={m.projects.type}>
              <NativeSelect
                value={data.type}
                onChange={(e) => {
                  set("type")(e);
                  setSelected(templates.filter((t) => (SUGGEST[e.target.value] ?? []).includes(t.key)).map((t) => t.id));
                }}
              >
                {PROJECT_TYPES.map((t) => <option key={t} value={t}>{m.enums.projectType[t]}</option>)}
              </NativeSelect>
            </Field>
            <Field label={m.common.priority}>
              <NativeSelect value={data.priority} onChange={set("priority")}>{Object.entries(m.enums.priority).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect>
            </Field>
            <Field label={m.projects.manager}>
              <NativeSelect value={data.managerId} onChange={set("managerId")}>{managers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</NativeSelect>
            </Field>
            <Field label={m.projects.contractRef}><Input value={data.contractRef} onChange={set("contractRef")} dir="ltr" /></Field>
            <Field label={`${m.projects.budget} (${m.common.sar})`}><Input value={data.budgetAmount} onChange={set("budgetAmount")} type="number" min={0} step="1000" dir="ltr" /></Field>
            <Field label={m.common.description} className="sm:col-span-2"><Textarea value={data.description} onChange={set("description")} rows={3} /></Field>
          </div>
        </Section>
      )}

      {step === 1 && (
        <Section>
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label={m.common.startDate}><Input type="date" value={data.startDate} onChange={set("startDate")} dir="ltr" /></Field>
            <Field label={m.projects.deadline} error={errorFor("deadline")}><Input type="date" value={data.deadline} onChange={set("deadline")} dir="ltr" /></Field>
            <Field label={m.projects.eventStart}><Input type="datetime-local" value={data.eventStartAt} onChange={set("eventStartAt")} dir="ltr" data-testid="event-start" /></Field>
            <Field label={m.projects.eventEnd} error={errorFor("eventEndAt")}><Input type="datetime-local" value={data.eventEndAt} onChange={set("eventEndAt")} dir="ltr" /></Field>
            <Field label={m.projects.venues} className="sm:col-span-2">
              <div className="flex flex-wrap gap-2">
                {venues.length === 0 && <span className="text-xs text-muted-foreground">{m.common.none}</span>}
                {venues.map((v) => (
                  <button key={v.id} type="button" onClick={() => setVenueIds((ids) => (ids.includes(v.id) ? ids.filter((x) => x !== v.id) : [...ids, v.id]))} className={cn("rounded-full border px-3 py-1 text-xs", venueIds.includes(v.id) && "border-primary bg-jade-soft text-primary")}>
                    {v.name} · {v.city}
                  </button>
                ))}
              </div>
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={data.clientPortal} onChange={(e) => setData((d) => ({ ...d, clientPortal: e.target.checked }))} /> {m.projects.clientPortal}</label>
          </div>
        </Section>
      )}

      {step === 2 && (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">{w.templatesHint}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => {
              const on = selected.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`tpl-${t.key}`}
                  aria-pressed={on}
                  onClick={() => setSelected((s) => (on ? s.filter((x) => x !== t.id) : [...s, t.id]))}
                  className={cn("surface relative flex flex-col items-start gap-1 p-3 text-start transition-colors hover:border-primary/50", on && "border-primary ring-1 ring-primary")}
                >
                  {on && <span className="absolute end-2 top-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="size-3" /></span>}
                  <span className="text-[11px] text-muted-foreground">{m.templates.categories[t.category as keyof typeof m.templates.categories] ?? t.category} · v{t.latestVersion}</span>
                  <span className="pe-6 text-[13px] font-medium">{t.name}</span>
                  <span className="text-xs text-muted-foreground">{t.description}</span>
                  {t.stats && <span className="tabular mt-1 text-[11px] text-muted-foreground">{interpolate(m.templates.workstreamsCount, { n: t.stats.workstreams })} · {interpolate(m.templates.tasksCount, { n: t.stats.tasks })}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {step === 3 && (
        <Section>
          <div className="grid gap-3 p-4 text-sm">
            <div className="text-lg font-semibold">{data.name}</div>
            <div className="text-muted-foreground">{m.enums.projectType[data.type as keyof typeof m.enums.projectType]} · {clients.find((c) => c.id === data.clientId)?.name ?? m.projects.noClient}</div>
            <div className="tabular text-xs text-muted-foreground">{m.projects.eventStart}: {formatDate(parseRiyadhDateTime(data.eventStartAt), fmt)} · {m.projects.deadline}: {formatDate(parseRiyadhDate(data.deadline), fmt)}</div>
            <div className="flex items-start gap-2 rounded-md bg-jade-soft p-3 text-primary">
              <Layers className="mt-0.5 size-4" />
              <div>
                <div className="font-medium">{templates.filter((t) => selected.includes(t.id)).map((t) => t.name).join(" + ") || m.common.none}</div>
                <div className="text-xs">{interpolate(w.composeSummary, totals)}</div>
              </div>
            </div>
          </div>
        </Section>
      )}

      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>{m.common.previous}</Button>
        {step < 3 ? (
          <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext}>{m.common.next}</Button>
        ) : (
          <Button onClick={submit} disabled={pending} data-testid="create-project">{pending ? m.common.saving : w.create}</Button>
        )}
      </div>
    </div>
  );
}
