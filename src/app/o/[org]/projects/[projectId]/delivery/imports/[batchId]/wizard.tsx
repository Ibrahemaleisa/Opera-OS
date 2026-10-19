"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Download, Loader2, RotateCcw, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/app/field";
import { ProgressBar, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formatDateTime } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { getImportPreview, listImportRows } from "@/server/modules/delivery/imports/service";
import { commitImportAction, configureImportAction, importPreviewAction, importStatusAction, resolveImportRowsAction, rollbackImportAction, updateImportRowAction } from "@/app/o/[org]/delivery/actions";

type Rows = Awaited<ReturnType<typeof listImportRows>>;
type Preview = Awaited<ReturnType<typeof getImportPreview>>;
type Row = Rows["rows"][number];

const STEP: Record<string, number> = { UPLOADED: 0, PARSED: 1, FAILED: 1, VALIDATING: 2, VALIDATED: 2, COMMITTING: 3, COMMITTED: 3, PARTIALLY_COMMITTED: 3, ROLLED_BACK: 3, CANCELLED: 3 };

export function ImportWizard({ orgSlug, projectId, data, preview, campaigns, statusFilter }: { orgSlug: string; projectId: string; data: Rows; preview: Preview | null; campaigns: { id: string; name: string }[]; statusFilter: string }) {
  const { m } = useI18n();
  const im = m.delivery.import;
  const b = data.batch;
  const [mapping, setMapping] = useState(false);
  const step = STEP[b.status] ?? 0;
  const showMapping = b.status === "PARSED" || b.status === "FAILED" || mapping;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <ol className="flex flex-wrap gap-2">
          {[im.steps.upload, im.steps.map, im.steps.review, im.steps.commit].map((s, i) => (
            <li key={s} className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs", i === step ? "border-primary bg-jade-soft text-primary" : i < step ? "text-foreground" : "text-muted-foreground")}>
              <span className={cn("flex size-4 items-center justify-center rounded-full text-[10px]", i < step ? "bg-primary text-primary-foreground" : "bg-muted")}>{i < step ? "✓" : i + 1}</span>{s}
            </li>
          ))}
        </ol>
        <span className="ltr-nums truncate text-sm font-medium">{b.fileName}</span>
        <StatusBadge status={b.status} label={m.enums.importStatus[b.status]} />
        {b.status === "VALIDATED" && !mapping && <Button size="sm" variant="ghost" onClick={() => setMapping(true)}><ArrowLeftRight /> {im.steps.map}</Button>}
      </div>
      {b.error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{m.errors.unexpected} ({b.error})</p>}
      {preview?.batch.previousIdenticalBatchId && <p className="flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"><AlertTriangle className="size-4" />{im.identicalFile}</p>}
      {(b.status === "VALIDATING" || b.status === "COMMITTING") && <Progress orgSlug={orgSlug} batchId={b.id} />}
      {showMapping && preview && <MappingStep orgSlug={orgSlug} preview={preview} onDone={() => setMapping(false)} />}
      {b.status === "VALIDATED" && !mapping && <ReviewStep orgSlug={orgSlug} projectId={projectId} data={data} campaigns={campaigns} statusFilter={statusFilter} />}
      {["COMMITTED", "PARTIALLY_COMMITTED", "ROLLED_BACK"].includes(b.status) && <DoneStep orgSlug={orgSlug} projectId={projectId} data={data} />}
    </div>
  );
}

function Progress({ orgSlug, batchId }: { orgSlug: string; batchId: string }) {
  const { m } = useI18n();
  const router = useRouter();
  const [p, setP] = useState({ progress: 0, status: "" });
  useEffect(() => {
    const id = setInterval(async () => {
      const r = await importStatusAction(orgSlug, { batchId });
      if (r.ok) {
        setP({ progress: r.data.progress, status: r.data.status });
        if (!["VALIDATING", "COMMITTING"].includes(r.data.status)) { clearInterval(id); router.refresh(); }
      }
    }, 1500);
    return () => clearInterval(id);
  }, [orgSlug, batchId, router]);
  return (
    <Section>
      <div className="grid gap-2 p-4">
        <div className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> {p.status === "COMMITTING" ? m.delivery.import.committing : m.delivery.import.validating}</div>
        <ProgressBar value={p.progress} />
        <p className="text-xs text-muted-foreground">{m.delivery.import.background}</p>
      </div>
    </Section>
  );
}

function MappingStep({ orgSlug, preview: initial, onDone }: { orgSlug: string; preview: Preview; onDone: () => void }) {
  const { m, locale } = useI18n();
  const im = m.delivery.import;
  const router = useRouter();
  const [preview, setPreview] = useState(initial);
  const [mapping, setMapping] = useState<Record<string, string>>(initial.mapping as Record<string, string>);
  const [opts, setOpts] = useState(initial.batch.options);
  const [saveAs, setSaveAs] = useState("");
  const reload = useAction(importPreviewAction, { orgSlug, success: false, refresh: false, onSuccess: (p) => { setPreview(p as Preview); setMapping(p.mapping as Record<string, string>); } });
  const configure = useAction(configureImportAction, { orgSlug, success: false, onSuccess: () => { onDone(); router.refresh(); } });
  const fields = [...preview.canonical, ...preview.customFields];
  const used = new Set(Object.values(mapping).filter(Boolean));
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="grid content-start gap-4">
        <Section title={im.preview}>
          <div className="flex flex-wrap gap-3 border-b p-3">
            <Field label={im.sheet}>
              <NativeSelect className="h-8 w-56" value={preview.sheetName} onChange={(e) => reload.run({ batchId: preview.batch.id, sheetName: e.target.value, headerRow: 1 })}>
                {preview.batch.sheetNames.map((s) => <option key={s} value={s}>{s}</option>)}
              </NativeSelect>
            </Field>
            <Field label={im.headerRow}>
              <NativeSelect className="h-8 w-24" value={preview.headerRow} onChange={(e) => reload.run({ batchId: preview.batch.id, sheetName: preview.sheetName, headerRow: Number(e.target.value) })}>
                {Array.from({ length: Math.min(10, preview.topRows.length) }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
              </NativeSelect>
            </Field>
            <span className="tabular self-end pb-1.5 text-xs text-muted-foreground">{preview.totalRows} {im.rows}</span>
          </div>
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr><th className="px-2 py-1.5 text-start">#</th>{preview.headers.map((h) => <th key={h} className={cn("px-2 py-1.5 text-start font-medium whitespace-nowrap", used.has(h) ? "text-primary" : "text-muted-foreground")}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {preview.sample.map((r) => (
                  <tr key={r.rowNumber} className="border-b">
                    <td className="tabular px-2 py-1 text-muted-foreground">{r.rowNumber}</td>
                    {preview.headers.map((h) => <td key={h} className="max-w-48 truncate px-2 py-1 whitespace-nowrap">{String(r.values[h] ?? "")}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
      <div className="grid content-start gap-4">
        <Section title={im.steps.map} actions={preview.savedMappings.length > 0 && (
          <NativeSelect className="h-7 w-44 text-xs" value="" onChange={(e) => { const sm = preview.savedMappings.find((x) => x.id === e.target.value); if (sm) setMapping(sm.mapping as Record<string, string>); }} aria-label={im.savedMappings}>
            <option value="">{im.savedMappings}…</option>
            {preview.savedMappings.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </NativeSelect>
        )}>
          <div className="max-h-[52vh] overflow-y-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-muted/90 text-xs text-muted-foreground"><tr><th className="px-3 py-1.5 text-start font-medium">{im.field}</th><th className="px-3 py-1.5 text-start font-medium">{im.column}</th></tr></thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.key} className="border-b last:border-0">
                    <td className="px-3 py-1.5">{locale === "ar" ? f.ar : f.en}</td>
                    <td className="px-3 py-1">
                      <NativeSelect className={cn("h-8", mapping[f.key] && "border-primary/50 bg-jade-soft/40")} value={mapping[f.key] ?? ""} onChange={(e) => setMapping((mm) => ({ ...mm, [f.key]: e.target.value }))} data-testid={`map-${f.key}`}>
                        <option value="">{im.ignore}</option>
                        {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </NativeSelect>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title={m.common.settings}>
          <div className="grid gap-3 p-4 text-sm">
            <Field label={im.duplicateScope}>
              <NativeSelect value={opts.duplicateScope} onChange={(e) => setOpts((o) => ({ ...o, duplicateScope: e.target.value as never }))}>
                <option value="PROJECT">{im.scopeProject}</option>
                <option value="ORGANIZATION">{im.scopeOrg}</option>
              </NativeSelect>
            </Field>
            <Field label={im.matchOn}>
              <div className="flex flex-wrap gap-3">
                {([["mobile", im.matchMobile], ["externalRef", im.matchRef], ["name", im.matchName], ["email", im.matchEmail]] as const).map(([k, l]) => (
                  <label key={k} className="flex items-center gap-1.5"><Checkbox checked={opts.matchOn.includes(k)} onCheckedChange={(v) => setOpts((o) => ({ ...o, matchOn: v ? [...o.matchOn, k] : o.matchOn.filter((x) => x !== k) }))} /> {l}</label>
                ))}
              </div>
            </Field>
            <label className="flex items-center gap-2"><Checkbox checked={opts.requireMobile} onCheckedChange={(v) => setOpts((o) => ({ ...o, requireMobile: !!v }))} /> {im.requireMobile}</label>
            <label className="flex items-center gap-2"><Checkbox checked={opts.requireLocation} onCheckedChange={(v) => setOpts((o) => ({ ...o, requireLocation: !!v }))} /> {im.requireLocation}</label>
            <Field label={im.defaultCity}><Input value={opts.defaultCity ?? ""} onChange={(e) => setOpts((o) => ({ ...o, defaultCity: e.target.value || null }))} className="h-8" /></Field>
            <Field label={im.saveMapping}><Input value={saveAs} onChange={(e) => setSaveAs(e.target.value)} className="h-8" placeholder={m.common.optional} /></Field>
            {configure.errorFor("mapping") && <p className="text-xs text-danger">{configure.errorFor("mapping")}</p>}
            <Button
              disabled={configure.pending || !opts.matchOn.length}
              data-testid="import-validate"
              onClick={() => configure.run({ batchId: preview.batch.id, sheetName: preview.sheetName, headerRow: preview.headerRow, mapping: Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, v || null])), options: { ...opts, defaultCity: opts.defaultCity ?? null }, saveMappingAs: saveAs || null })}
            >
              {configure.pending ? <><Loader2 className="animate-spin" /> {im.validating}</> : im.validate}
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function issueText(tk: (k: string) => string, xs: unknown) {
  return (xs as { field: string; code: string }[]).map((i) => tk(`importErrors.${i.code}`)).join(" · ");
}

function ReviewStep({ orgSlug, projectId, data, campaigns, statusFilter }: { orgSlug: string; projectId: string; data: Rows; campaigns: { id: string; name: string }[]; statusFilter: string }) {
  const { m, tk } = useI18n();
  const im = m.delivery.import;
  const router = useRouter();
  const pathname = usePathname();
  const [fixRow, setFixRow] = useState<Row | null>(null);
  const [includeWarnings, setIncludeWarnings] = useState(true);
  const [acceptPartial, setAcceptPartial] = useState(false);
  const [campaignId, setCampaignId] = useState(data.batch.campaignId ?? "");
  const resolve = useAction(resolveImportRowsAction, { orgSlug, success: false });
  const commit = useAction(commitImportAction, { orgSlug, success: false, onSuccess: () => toast.success(m.common.success) });
  const c = data.counts;
  const pendingDup = data.rows.filter((r) => r.status === "DUPLICATE" && r.resolution === "PENDING").length;
  const unresolvedInvalid = data.rows.filter((r) => r.status === "INVALID" && r.resolution !== "SKIP").length;
  const blocking = (statusFilter ? null : pendingDup + unresolvedInvalid) ?? (c.INVALID ?? 0) + (c.DUPLICATE ?? 0);
  const chips = [["", m.common.all, data.total], ["VALID", m.enums.importRowStatus.VALID, c.VALID], ["WARNING", m.enums.importRowStatus.WARNING, c.WARNING], ["INVALID", m.enums.importRowStatus.INVALID, c.INVALID], ["DUPLICATE", m.enums.importRowStatus.DUPLICATE, c.DUPLICATE]] as const;
  const dupInfo = (r: Row) => {
    if (r.duplicateOfRecipientId) {
      const d = data.duplicates[r.duplicateOfRecipientId];
      return d ? `${im.existingRecord}: ${d.code} ${d.nameAr ?? d.nameEn ?? ""}${d.projectId !== projectId ? " ↗" : ""}` : im.existingRecord;
    }
    return r.duplicateOfRow ? interpolate(im.rowInFile, { n: r.duplicateOfRow }) : "";
  };
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {chips.map(([k, label, n]) => (
          <button key={k} onClick={() => router.replace(k ? `${pathname}?status=${k}` : pathname)} className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs", statusFilter === k && "border-primary bg-jade-soft text-primary")} data-testid={`chip-${k || "ALL"}`}>
            {k && <StatusBadge status={k} label="" className="w-2 px-0" dot />} {label} <span className="tabular font-semibold">{n ?? 0}</span>
          </button>
        ))}
        <div className="ms-auto flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={resolve.pending || !c.DUPLICATE} onClick={() => resolve.run({ batchId: data.batch.id, scope: "ALL_DUPLICATES", resolution: "SKIP" })} data-testid="skip-duplicates">{im.skipAllDuplicates}</Button>
          <Button size="sm" variant="outline" disabled={resolve.pending || !c.INVALID} onClick={() => resolve.run({ batchId: data.batch.id, scope: "ALL_INVALID", resolution: "SKIP" })} data-testid="skip-invalid">{im.skipAllInvalid}</Button>
          <Button size="sm" variant="ghost" asChild><a href={`/api/o/${orgSlug}/imports/${data.batch.id}/report?kind=errors`}><Download /> {im.errorReport}</a></Button>
        </div>
      </div>
      <Section>
        <div className="max-h-[56vh] overflow-auto">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>{[im.row, m.common.status, m.common.name, m.common.phone, m.common.city, im.issues, im.duplicateOf, im.resolution, ""].map((h, i) => <th key={i} className="h-8 px-2 text-start font-medium whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const n = (r.normalized ?? {}) as Record<string, string | null>;
                return (
                  <tr key={r.id} className={cn("border-b align-top", r.status === "INVALID" && r.resolution !== "SKIP" && "bg-danger-soft/40", r.resolution === "SKIP" && "opacity-50")} data-testid={`import-row-${r.status}`}>
                    <td className="tabular px-2 py-1.5 text-muted-foreground">{r.rowNumber}</td>
                    <td className="px-2 py-1.5"><StatusBadge status={r.status} label={m.enums.importRowStatus[r.status]} /></td>
                    <td className="px-2 py-1.5"><div className="font-medium">{n.nameAr ?? n.nameEn ?? "—"}</div>{n.organizationName && <div className="text-[11px] text-muted-foreground">{n.organizationName}</div>}</td>
                    <td className="ltr-nums px-2 py-1.5 whitespace-nowrap">{data.vip ? n.mobile ?? n.mobileRaw ?? "—" : n.mobile ? `•••${n.mobile.slice(-4)}` : "—"}</td>
                    <td className="px-2 py-1.5">{[n.city, n.district].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="max-w-72 px-2 py-1.5">
                      {(r.errors as unknown[]).length > 0 && <div className="text-danger">{issueText(tk, r.errors)}</div>}
                      {(r.warnings as unknown[]).length > 0 && <div className="text-warning">{issueText(tk, r.warnings)}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-[11px] text-violet">{dupInfo(r)}</td>
                    <td className="px-2 py-1">
                      {(r.status === "DUPLICATE" || r.status === "INVALID") && (
                        <NativeSelect className="h-7 w-40 text-xs" value={r.resolution} onChange={(e) => resolve.run({ batchId: data.batch.id, rowIds: [r.id], resolution: e.target.value as never })}>
                          <option value="PENDING">{m.enums.duplicateResolution.PENDING}</option>
                          <option value="SKIP">{m.enums.duplicateResolution.SKIP}</option>
                          {r.status === "DUPLICATE" && <option value="IMPORT_AS_NEW">{m.enums.duplicateResolution.IMPORT_AS_NEW}</option>}
                          {r.status === "DUPLICATE" && r.duplicateOfRecipientId && <option value="LINK_EXISTING">{m.enums.duplicateResolution.LINK_EXISTING}</option>}
                        </NativeSelect>
                      )}
                    </td>
                    <td className="px-2 py-1"><Button variant="ghost" size="xs" onClick={() => setFixRow(r)}><Wrench /> {im.fix}</Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.total > data.rows.length && <p className="p-3 text-center text-xs text-muted-foreground">{data.rows.length} / {data.total}</p>}
        </div>
      </Section>
      <Section title={im.steps.commit}>
        <div className="grid gap-3 p-4 text-sm md:grid-cols-[1fr_auto] md:items-end">
          <div className="grid gap-2">
            <div className="tabular text-muted-foreground">{interpolate(im.summary, { valid: c.VALID ?? 0, warning: c.WARNING ?? 0, invalid: c.INVALID ?? 0, duplicate: c.DUPLICATE ?? 0 })}</div>
            <Field label={im.targetCampaign} className="max-w-sm">
              <NativeSelect value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">{im.noCards}</option>
                {campaigns.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </NativeSelect>
            </Field>
            <label className="flex items-center gap-2"><Checkbox checked={includeWarnings} onCheckedChange={(v) => setIncludeWarnings(!!v)} /> {im.includeWarnings}</label>
            {(blocking ?? 0) > 0 && (
              <div className="rounded-md bg-warning-soft p-3 text-warning">
                <p className="mb-2 flex items-center gap-1.5 text-[13px]"><AlertTriangle className="size-4" /> {im.partialRequired}</p>
                <label className="flex items-center gap-2 text-foreground"><Checkbox checked={acceptPartial} onCheckedChange={(v) => setAcceptPartial(!!v)} data-testid="accept-partial" /> {im.acceptPartial}</label>
              </div>
            )}
          </div>
          <Button disabled={commit.pending} onClick={() => commit.run({ batchId: data.batch.id, includeWarnings, acceptPartial, campaignId: campaignId || null })} data-testid="import-commit">
            {commit.pending ? <><Loader2 className="animate-spin" /> {im.committing}</> : <><CheckCircle2 /> {im.commit}</>}
          </Button>
        </div>
      </Section>
      {fixRow && <FixRowDialog orgSlug={orgSlug} batchId={data.batch.id} row={fixRow} onClose={() => setFixRow(null)} />}
    </div>
  );
}

function FixRowDialog({ orgSlug, batchId, row, onClose }: { orgSlug: string; batchId: string; row: Row; onClose: () => void }) {
  const { m, tk } = useI18n();
  const n = (row.normalized ?? {}) as Record<string, string | null>;
  const fields = [["nameAr", m.common.nameAr], ["nameEn", m.common.nameEn], ["organizationName", m.projects.client], ["mobile", m.common.phone], ["city", m.common.city], ["district", m.common.district], ["address", m.common.address], ["mapsUrl", m.org.mapsUrl]] as const;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(([k]) => [k, (k === "mobile" ? n.mobile ?? n.mobileRaw : n[k]) ?? ""])));
  const { run, pending } = useAction(updateImportRowAction, { orgSlug, onSuccess: onClose });
  const issues = useMemo(() => [...(row.errors as { code: string }[]), ...(row.warnings as { code: string }[])], [row]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{m.delivery.import.row} {row.rowNumber}</DialogTitle>
          <DialogDescription>{issues.map((i) => tk(`importErrors.${i.code}`)).join(" · ")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map(([k, label]) => (
            <Field key={k} label={label}><Input value={values[k]} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} dir={k === "mobile" || k === "mapsUrl" || k === "nameEn" ? "ltr" : undefined} /></Field>
          ))}
        </div>
        <DialogFooter>
          <Button disabled={pending} onClick={() => {
            const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== ((k === "mobile" ? n.mobile ?? n.mobileRaw : n[k]) ?? "")).map(([k, v]) => [k, v || null]));
            run({ batchId, rowId: row.id, overrides: changed });
          }}>{m.common.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DoneStep({ orgSlug, projectId, data }: { orgSlug: string; projectId: string; data: Rows }) {
  const { m, fmt } = useI18n();
  const im = m.delivery.import;
  const [confirm, setConfirm] = useState(false);
  const rollback = useAction(rollbackImportAction, { orgSlug, success: im.rolledBack, onSuccess: () => setConfirm(false) });
  const b = data.batch;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Section>
        <div className="grid gap-3 p-5">
          <div className="flex items-center gap-2 text-lg font-semibold">{b.status === "ROLLED_BACK" ? <RotateCcw className="size-5 text-muted-foreground" /> : <CheckCircle2 className="size-5 text-success" />}{b.status === "ROLLED_BACK" ? im.rolledBack : interpolate(im.committed, { n: b.committedRows })}</div>
          <div className="tabular text-sm text-muted-foreground">{interpolate(im.summary, { valid: b.validRows, warning: b.warningRows, invalid: b.invalidRows, duplicate: b.duplicateRows })} · {m.enums.importRowStatus.SKIPPED}: {data.counts.SKIPPED ?? 0}</div>
          {data.campaign && <div className="text-sm">{m.delivery.campaign}: <Link className="text-primary hover:underline" href={`/o/${orgSlug}/projects/${projectId}/delivery/cards?c=${data.campaign.id}`}>{data.campaign.name}</Link></div>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" asChild><a href={`/api/o/${orgSlug}/imports/${b.id}/report?kind=errors`}><Download /> {im.errorReport}</a></Button>
            <Button size="sm" variant="outline" asChild><a href={`/api/o/${orgSlug}/imports/${b.id}/report?kind=normalized`}><Download /> {im.exportNormalized}</a></Button>
            <Button size="sm" variant="outline" asChild><a href={`/api/o/${orgSlug}/imports/${b.id}/report?kind=original`}><Download /> {im.exportOriginal}</a></Button>
            {b.status !== "ROLLED_BACK" && <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirm(true)}><RotateCcw /> {im.rollback}</Button>}
          </div>
        </div>
      </Section>
      <Section title={m.common.history}>
        <ol className="divide-y">
          {data.history.map((h) => (
            <li key={h.id} className="px-4 py-2 text-xs"><span className="ltr-nums font-mono">{h.action}</span> · {h.actorName}{h.summary && <div className="text-muted-foreground">{h.summary}</div>}<div className="tabular text-[10px] text-muted-foreground">{formatDateTime(h.createdAt, fmt)}</div></li>
          ))}
        </ol>
      </Section>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader><DialogTitle>{im.rollback}</DialogTitle><DialogDescription>{im.rollbackConfirm}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="destructive" disabled={rollback.pending} onClick={() => rollback.run({ batchId: b.id })}>{m.common.confirm}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
