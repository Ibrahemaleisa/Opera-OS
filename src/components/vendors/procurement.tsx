"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Award, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { FormDialog, enumOptions, type FieldDef } from "@/components/app/form-dialog";
import { useAction } from "@/hooks/use-action";
import { ConfirmAction } from "@/components/app/confirm-action";
import { DateText } from "@/components/app/date-text";
import { formatMoney } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { listProcurement } from "@/server/modules/vendors/service";
import { awardQuoteAction, createRfqAction, createWorkOrderAction, recordQuoteAction, setWorkOrderStatusAction } from "@/app/o/[org]/vendors/actions";

type D = Awaited<ReturnType<typeof listProcurement>>;
type Q = D["rfqs"][number]["quotes"][number];
type Dlg = { kind: "rfq" | "quote" | "award" | "wo"; rfq?: D["rfqs"][number]; quote?: Q } | null;

export function Procurement({ orgSlug, projectId, currency, data }: { orgSlug: string; projectId: string; currency: string; data: D }) {
  const { m, fmt } = useI18n();
  const t = m.vendors;
  const [dlg, setDlg] = useState<Dlg>(null);
  const close = () => setDlg(null);
  const money = (v: number | null) => (v === null ? "•••" : formatMoney(v, { ...fmt, currency }));
  const vname = (id: string) => data.vendors.find((v) => v.id === id)?.name ?? "—";
  const can = data.canManage;

  const rfq = useAction(createRfqAction, { orgSlug, onSuccess: close });
  const quote = useAction(recordQuoteAction, { orgSlug, onSuccess: close });
  const award = useAction(awardQuoteAction, { orgSlug, success: false, onSuccess: (r) => { toast.success(interpolate(t.awarded, { code: r.code })); close(); } });
  const wo = useAction(createWorkOrderAction, { orgSlug, onSuccess: close });
  const woStatus = useAction(setWorkOrderStatusAction, { orgSlug, success: false });

  const activeVendors = data.vendors.filter((v) => v.status !== "BLACKLISTED");
  const fields: Record<NonNullable<Dlg>["kind"], FieldDef[]> = {
    rfq: [
      { name: "title", label: m.common.title, required: true, wide: true },
      { name: "category", label: t.category, type: "select", empty: "—", options: enumOptions(m.enums.vendorCategory) },
      { name: "dueAt", label: t.due, type: "datetime" },
      { name: "description", label: m.common.description, type: "textarea" },
    ],
    quote: [
      { name: "vendorId", label: m.finance.vendor, type: "select", required: true, options: (dlg?.rfq ? activeVendors.filter((v) => dlg.rfq!.vendorIds.includes(v.id)) : activeVendors).map((v) => ({ value: v.id, label: v.name })) },
      { name: "reference", label: t.reference, ltr: true },
      { name: "amount", label: t.amount, type: "number", min: 0, required: true },
      { name: "vatAmount", label: t.vatAmount, type: "number", min: 0 },
      { name: "leadTimeDays", label: t.leadTime, type: "number", min: 0 },
      { name: "validUntil", label: t.validUntil, type: "datetime" },
      { name: "notes", label: m.common.notes, type: "textarea" },
    ],
    award: [
      { name: "budgetCategory", label: t.budgetCategory, type: "select", options: enumOptions(m.enums.budgetCategory) },
      { name: "justification", label: t.justification, type: "textarea", hint: t.justificationHint },
    ],
    wo: [
      { name: "title", label: m.common.title, required: true, wide: true },
      { name: "vendorId", label: m.finance.vendor, type: "select", required: true, options: activeVendors.map((v) => ({ value: v.id, label: v.name })) },
      { name: "dueAt", label: t.due, type: "datetime" },
      { name: "scope", label: t.scope, type: "textarea" },
    ],
  };
  const [rfqVendors, setRfqVendors] = useState<string[]>([]);
  const submit = (kind: NonNullable<Dlg>["kind"], v: Record<string, unknown>) => {
    if (kind === "rfq") rfq.run({ ...v, projectId, vendorIds: rfqVendors } as never);
    if (kind === "quote") quote.run({ ...v, projectId, rfqId: dlg?.rfq?.id ?? null, vatAmount: v.vatAmount ?? 0 } as never);
    if (kind === "award") award.run({ ...v, quoteId: dlg!.quote!.id } as never);
    if (kind === "wo") wo.run({ ...v, projectId } as never);
  };
  const titles = { rfq: t.newRfq, quote: t.recordQuote, award: t.awardTitle, wo: t.newWorkOrder };
  const pending = rfq.pending || quote.pending || award.pending || wo.pending;
  const errorFor = (f: string) => rfq.errorFor(f) ?? quote.errorFor(f) ?? award.errorFor(f) ?? wo.errorFor(f);

  return (
    <div className="grid gap-4">
      <Section title={`${t.rfqs} (${data.rfqs.length})`} actions={can && <Button size="sm" onClick={() => { setRfqVendors([]); setDlg({ kind: "rfq" }); }}><Plus /> {t.newRfq}</Button>}>
        {data.rfqs.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
          <ul className="divide-y">
            {data.rfqs.map((r) => {
              const received = r.quotes.filter((q) => q.status !== "REQUESTED" && q.amount !== null);
              const lowest = received.length ? Math.min(...received.filter((q) => ["RECEIVED", "SHORTLISTED", "ACCEPTED"].includes(q.status)).map((q) => q.amount! + (q.vatAmount ?? 0))) : null;
              return (
                <li key={r.id} className="grid gap-3 px-4 py-4" data-testid="rfq">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="ltr-nums font-mono text-xs text-muted-foreground">{r.code}</span>
                    <span className="text-[13px] font-medium">{r.title}</span>
                    <StatusBadge status={r.status === "AWARDED" ? "DONE" : r.status} label={t.rfqStatus[r.status as keyof typeof t.rfqStatus]} />
                    {r.dueAt && <span className="text-[11px] text-muted-foreground">{t.due}: <DateText value={r.dueAt} /></span>}
                    {can && r.status === "OPEN" && <Button size="xs" variant="outline" className="ms-auto" onClick={() => setDlg({ kind: "quote", rfq: r })}><Plus /> {t.recordQuote}</Button>}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead className="text-[11px] text-muted-foreground"><tr>{[m.finance.vendor, t.amount, t.vatAmount, m.finance.total, t.leadTime, t.validUntil, m.common.status, ""].map((h, i) => <th key={i} className="px-2 py-1 text-start font-medium">{h}</th>)}</tr></thead>
                      <tbody className="divide-y">
                        {r.quotes.map((q) => {
                          const total = q.amount === null ? null : q.amount + (q.vatAmount ?? 0);
                          const isLowest = total !== null && total === lowest && q.status !== "REQUESTED";
                          return (
                            <tr key={q.id} className={cn(q.status === "ACCEPTED" && "bg-success-soft/40", q.status === "REJECTED" && "opacity-50")}>
                              <td className="px-2 py-1.5">{vname(q.vendorId)}{isLowest && <span className="ms-1 rounded bg-success-soft px-1 text-[10px] text-success">{t.lowest}</span>}</td>
                              <td className="tabular px-2 py-1.5">{q.status === "REQUESTED" ? "—" : money(q.amount)}</td>
                              <td className="tabular px-2 py-1.5">{q.status === "REQUESTED" ? "—" : money(q.vatAmount)}</td>
                              <td className="tabular px-2 py-1.5 font-medium">{q.status === "REQUESTED" ? "—" : money(total)}</td>
                              <td className="tabular px-2 py-1.5">{q.leadTimeDays ?? "—"}</td>
                              <td className="px-2 py-1.5 text-xs"><DateText value={q.validUntil} /></td>
                              <td className="px-2 py-1.5"><StatusBadge status={q.status === "ACCEPTED" ? "DONE" : q.status === "REQUESTED" ? "PENDING" : q.status === "RECEIVED" ? "SUBMITTED" : q.status} label={m.enums.quoteStatus[q.status]} /></td>
                              <td className="px-2 py-1.5">{can && r.status === "OPEN" && ["RECEIVED", "SHORTLISTED"].includes(q.status) && <Button size="xs" onClick={() => setDlg({ kind: "award", rfq: r, quote: q })} data-testid="quote-award"><Award /> {t.award}</Button>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={`${t.workOrders} (${data.workOrders.length})`} actions={can && <Button size="sm" onClick={() => setDlg({ kind: "wo" })}><Plus /> {t.newWorkOrder}</Button>}>
        {data.workOrders.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
          <ul className="divide-y">
            {data.workOrders.map((w) => (
              <li key={w.id} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_160px_140px_auto] md:items-center" data-testid="work-order" data-status={w.status}>
                <div><div className="text-[13px] font-medium">{w.title}</div><div className="text-[11px] text-muted-foreground">{vname(w.vendorId)}{w.scope ? ` · ${w.scope}` : ""}</div></div>
                <span className="text-xs text-muted-foreground">{w.dueAt ? <>{t.due}: <DateText value={w.dueAt} /></> : "—"}</span>
                <div className="grid gap-0.5"><StatusBadge status={w.status === "ACCEPTED_BY_AGENCY" ? "DONE" : w.status === "DELIVERED" ? "REVIEW" : w.status === "CANCELLED" ? "CANCELLED" : "IN_PROGRESS"} label={t.woStatus[w.status as keyof typeof t.woStatus]} />{w.rating && <span className="text-[10px] text-muted-foreground">★ {w.rating}{w.onTime === false ? " · ⏱" : ""}</span>}</div>
                {can && (
                  <div className="flex flex-wrap gap-1">
                    {w.status === "DELIVERED" && (
                      <ConfirmAction
                        trigger={<Button size="sm" data-testid="wo-accept">{t.acceptDelivery}</Button>}
                        title={m.common.confirmDialog.rateVendorTitle}
                        description={`${w.title} · ${vname(w.vendorId)}`}
                        field={{ type: "select", label: t.ratingPrompt, required: true, defaultValue: "5", options: ["5", "4", "3", "2", "1"].map((v) => ({ value: v, label: "★".repeat(Number(v)) + ` ${v}` })) }}
                        confirmLabel={t.acceptDelivery}
                        onConfirm={(rating) => woStatus.run({ id: w.id, status: "ACCEPTED_BY_AGENCY", rating: Number(rating) })}
                        testId="wo-accept-dialog"
                      />
                    )}
                    {["ISSUED", "ACCEPTED", "IN_PROGRESS"].includes(w.status) && (
                      <ConfirmAction
                        trigger={<Button size="sm" variant="ghost" className="text-danger">{t.cancel}</Button>}
                        title={interpolate(m.common.confirmDialog.cancelWorkOrderTitle, { name: w.title })}
                        description={m.common.confirmDialog.cancelWorkOrderBody}
                        confirmLabel={t.cancel}
                        destructive
                        onConfirm={() => woStatus.run({ id: w.id, status: "CANCELLED" })}
                      />
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {dlg && (
        <FormDialog open onOpenChange={(o) => !o && close()} title={dlg.kind === "award" && dlg.quote ? `${t.awardTitle} — ${vname(dlg.quote.vendorId)}` : titles[dlg.kind]} fields={fields[dlg.kind]} values={dlg.kind === "award" ? { budgetCategory: "PRODUCTION" } : null} onSubmit={(v) => submit(dlg.kind, v)} pending={pending} errorFor={errorFor} testId={`form-${dlg.kind}`}>
          {dlg.kind === "rfq" && (
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-xs font-medium">{t.invited}</legend>
              <div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
                {activeVendors.map((v) => (
                  <label key={v.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={rfqVendors.includes(v.id)} onChange={(e) => setRfqVendors((xs) => (e.target.checked ? [...xs, v.id] : xs.filter((x) => x !== v.id)))} /> {v.name}</label>
                ))}
              </div>
            </fieldset>
          )}
        </FormDialog>
      )}
    </div>
  );
}
