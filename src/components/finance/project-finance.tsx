"use client";

import { useState } from "react";
import { Paperclip, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Attachments } from "@/components/app/attachments";
import { EmptyState, Section, Stat } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { FormDialog, enumOptions, type FieldDef } from "@/components/app/form-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAction } from "@/hooks/use-action";
import { formatDate, formatMoney, formatPercent } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { getProjectFinance } from "@/server/modules/finance/service";
import {
  createChangeOrderAction,
  createExpenseAction,
  createPurchaseOrderAction,
  markExpensePaidAction,
  requestExpenseApprovalAction,
  saveBudgetAction,
  setContractValueAction,
  setPurchaseOrderStatusAction,
  submitChangeOrderAction,
  submitPurchaseOrderAction,
} from "@/app/o/[org]/finance/actions";

type D = Awaited<ReturnType<typeof getProjectFinance>>;
type Dlg = { kind: "budget" | "contract" | "po" | "expense" | "co"; values?: Record<string, unknown> | null } | null;

const PO_NEXT: Record<string, { to: "ISSUED" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CLOSED" | "CANCELLED"; key: "issue" | "partial" | "receive" | "close" | "cancel" }[]> = {
  APPROVED: [{ to: "ISSUED", key: "issue" }, { to: "CANCELLED", key: "cancel" }],
  ISSUED: [{ to: "PARTIALLY_RECEIVED", key: "partial" }, { to: "RECEIVED", key: "receive" }],
  PARTIALLY_RECEIVED: [{ to: "RECEIVED", key: "receive" }],
  RECEIVED: [{ to: "CLOSED", key: "close" }],
};

export function ProjectFinance({ orgSlug, data }: { orgSlug: string; data: D }) {
  const { m, fmt } = useI18n();
  const t = m.finance;
  const [dlg, setDlg] = useState<Dlg>(null);
  const [evidenceFor, setEvidenceFor] = useState<D["expenses"][number] | null>(null);
  const close = () => setDlg(null);
  const money = (v: number | null | undefined) => formatMoney(v ?? null, { ...fmt, currency: data.project.currency });
  const s = data.summary;
  const can = data.canManage;
  const pid = data.project.id;

  const budget = useAction(saveBudgetAction, { orgSlug, onSuccess: close });
  const contract = useAction(setContractValueAction, { orgSlug, onSuccess: close });
  const newPo = useAction(createPurchaseOrderAction, { orgSlug, onSuccess: close });
  const submitPo = useAction(submitPurchaseOrderAction, { orgSlug });
  const poStatus = useAction(setPurchaseOrderStatusAction, { orgSlug });
  const newExp = useAction(createExpenseAction, { orgSlug, onSuccess: close });
  const reqExp = useAction(requestExpenseApprovalAction, { orgSlug });
  const paid = useAction(markExpensePaidAction, { orgSlug });
  const newCo = useAction(createChangeOrderAction, { orgSlug, onSuccess: close });
  const submitCo = useAction(submitChangeOrderAction, { orgSlug });

  const cats = enumOptions(m.enums.budgetCategory);
  const vendors = data.vendors.map((v) => ({ value: v.id, label: v.name }));
  const fields: Record<NonNullable<Dlg>["kind"], FieldDef[]> = {
    budget: [{ name: "category", label: t.category, type: "select", options: cats }, { name: "planned", label: t.planned, type: "number", min: 0, required: true }, { name: "notes", label: m.common.notes, type: "textarea" }],
    contract: [{ name: "contractValue", label: t.contract, type: "number", min: 0, wide: true }],
    po: [
      { name: "title", label: m.common.title, required: true, wide: true },
      { name: "vendorId", label: t.vendor, type: "select", options: vendors, required: true },
      { name: "budgetCategory", label: t.category, type: "select", options: cats },
      { name: "amount", label: t.amount, type: "number", min: 0, required: true },
      { name: "vatAmount", label: t.vat, type: "number", min: 0, hint: "15%" },
    ],
    expense: [
      { name: "description", label: m.common.description, required: true, wide: true },
      { name: "budgetCategory", label: t.category, type: "select", options: cats },
      { name: "purchaseOrderId", label: t.po, type: "select", empty: "—", options: data.purchaseOrders.filter((p) => ["APPROVED", "ISSUED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED"].includes(p.status)).map((p) => ({ value: p.id, label: `${p.code} · ${p.title}` })) },
      { name: "vendorId", label: t.vendor, type: "select", empty: "—", options: vendors },
      { name: "amount", label: t.amount, type: "number", min: 0, required: true },
      { name: "vatAmount", label: t.vat, type: "number", min: 0 },
      { name: "incurredAt", label: t.incurredAt, type: "datetime", required: true },
    ],
    co: [
      { name: "title", label: m.common.title, required: true, wide: true },
      { name: "amountDelta", label: t.amountDelta, type: "number", required: true },
      { name: "costDelta", label: t.costDelta, type: "number" },
      { name: "clientVisible", label: t.clientVisible, type: "checkbox" },
      { name: "description", label: m.common.description, type: "textarea" },
    ],
  };
  const submit = (kind: NonNullable<Dlg>["kind"], v: Record<string, unknown>) => {
    if (kind === "budget") budget.run({ ...v, projectId: pid } as never);
    if (kind === "contract") contract.run({ projectId: pid, contractValue: (v.contractValue as number | null) ?? null });
    if (kind === "po") newPo.run({ ...v, projectId: pid, vatAmount: v.vatAmount ?? 0 } as never);
    if (kind === "expense") newExp.run({ ...v, projectId: pid, vatAmount: v.vatAmount ?? 0 } as never);
    if (kind === "co") newCo.run({ ...v, projectId: pid, costDelta: v.costDelta ?? 0 } as never);
  };
  const titles = { budget: t.setBudget, contract: t.setContract, po: t.newPo, expense: t.newExpense, co: t.newChangeOrder };
  const pending = budget.pending || contract.pending || newPo.pending || newExp.pending || newCo.pending;
  const errorFor = (f: string) => budget.errorFor(f) ?? newPo.errorFor(f) ?? newExp.errorFor(f) ?? newCo.errorFor(f) ?? contract.errorFor(f);
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, (a / b) * 100) : 0);

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label={t.revisedContract} value={money(s.contract.revised)} hint={s.contract.changeOrders ? `${t.changeOrders}: ${money(s.contract.changeOrders)}` : undefined} />
        <Stat label={t.planned} value={money(s.totals.planned)} />
        <Stat label={t.committed} value={money(s.totals.committed)} />
        <Stat label={t.actual} value={money(s.totals.actual)} />
        <Stat label={t.forecast} value={money(s.totals.forecast)} tone={s.totals.planned > 0 && s.totals.forecast > s.totals.planned ? "danger" : "default"} />
        <Stat label={t.margin} value={s.margin ? money(s.margin.amount) : "—"} hint={s.margin ? formatPercent(s.margin.ratio, fmt) : undefined} tone={s.margin && s.margin.amount < 0 ? "danger" : s.margin ? "success" : "default"} />
      </div>
      <p className="text-xs text-muted-foreground">{interpolate(t.thresholdNote, { amount: money(data.threshold) })}</p>

      <Section title={t.budget} actions={can && <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setDlg({ kind: "contract", values: { contractValue: s.contract.original } })}>{t.setContract}</Button><Button size="sm" onClick={() => setDlg({ kind: "budget", values: { category: "PRODUCTION" } })}><Plus /> {t.setBudget}</Button></div>}>
        {s.lines.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]" data-testid="budget-table">
              <thead className="border-b bg-muted/40 text-[11px] text-muted-foreground"><tr>{[t.category, t.planned, t.committed, t.actual, t.forecast, t.variance, ""].map((h, i) => <th key={i} className="px-3 py-2 text-start font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y">
                {s.lines.map((l) => (
                  <tr key={l.category} className={cn(can && "cursor-pointer hover:bg-muted/40")} onClick={() => can && setDlg({ kind: "budget", values: { category: l.category, planned: l.planned } })}>
                    <td className="px-3 py-2 font-medium">{m.enums.budgetCategory[l.category as keyof typeof m.enums.budgetCategory] ?? l.category}</td>
                    <td className="tabular px-3 py-2">{money(l.planned)}</td>
                    <td className="tabular px-3 py-2">{money(l.committed)}</td>
                    <td className="tabular px-3 py-2">{money(l.actual)}</td>
                    <td className="tabular px-3 py-2">{money(l.forecast)}</td>
                    <td className={cn("tabular px-3 py-2", l.variance < 0 && "text-danger")}>{money(l.variance)}</td>
                    <td className="w-40 px-3 py-2">
                      <div className="relative h-2 rounded-full bg-muted" title={`${t.committed} / ${t.planned}`}>
                        <div className="absolute inset-y-0 start-0 rounded-full bg-primary/40" style={{ width: `${pct(l.committed, l.planned || l.forecast)}%` }} />
                        <div className={cn("absolute inset-y-0 start-0 rounded-full", l.overBudget ? "bg-danger" : "bg-primary")} style={{ width: `${pct(l.actual, l.planned || l.forecast)}%` }} />
                      </div>
                      {l.overBudget && <span className="text-[10px] text-danger">{t.overBudget}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={`${t.pos} (${data.purchaseOrders.length})`} actions={can && <Button size="sm" onClick={() => setDlg({ kind: "po", values: { budgetCategory: "PRODUCTION" } })}><Plus /> {t.newPo}</Button>}>
        {data.purchaseOrders.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
          <ul className="divide-y">
            {data.purchaseOrders.map((p) => (
              <li key={p.id} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_140px_150px_auto] md:items-center" data-testid="po-row" data-status={p.status}>
                <div><div className="text-[13px] font-medium"><span className="ltr-nums font-mono text-xs text-muted-foreground">{p.code}</span> {p.title}</div><div className="text-[11px] text-muted-foreground">{p.vendorName} · {m.enums.budgetCategory[p.budgetCategory as keyof typeof m.enums.budgetCategory] ?? p.budgetCategory}</div></div>
                <span className="tabular text-xs">{money(p.amount + p.vatAmount)}<div className="text-[10px] text-muted-foreground">{t.vat}: {money(p.vatAmount)}</div></span>
                <div className="grid gap-0.5"><StatusBadge status={p.status} label={m.enums.poStatus[p.status]} />{p.status === "DRAFT" && p.needsApproval && <span className="text-[10px] text-warning">{t.needsApproval}</span>}{p.approval?.decisionComment && <span className="text-[10px] text-muted-foreground">“{p.approval.decisionComment}”</span>}</div>
                {can && (
                  <div className="flex flex-wrap gap-1">
                    {p.status === "DRAFT" && <Button size="xs" onClick={() => submitPo.run({ id: p.id })} disabled={submitPo.pending} data-testid="po-submit"><Send /> {t.submit}</Button>}
                    {PO_NEXT[p.status]?.map((n) => <Button key={n.to} size="xs" variant={n.to === "CANCELLED" ? "ghost" : "outline"} className={n.to === "CANCELLED" ? "text-danger" : undefined} onClick={() => poStatus.run({ id: p.id, status: n.to })}>{t[n.key]}</Button>)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`${t.expenses} (${data.expenses.length})`} actions={<Button size="sm" onClick={() => setDlg({ kind: "expense", values: { budgetCategory: "LOGISTICS", incurredAt: new Date() } })} data-testid="new-expense"><Plus /> {t.newExpense}</Button>}>
        {data.expenses.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
          <ul className="divide-y">
            {data.expenses.map((e) => (
              <li key={e.id} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_130px_120px_110px_auto] md:items-center" data-testid="expense-row" data-status={e.status}>
                <div><div className="text-[13px] font-medium">{e.description}</div><div className="text-[11px] text-muted-foreground">{m.enums.budgetCategory[e.budgetCategory as keyof typeof m.enums.budgetCategory]}{e.vendorName ? ` · ${e.vendorName}` : ""}</div></div>
                <span className="tabular text-xs">{money(e.amount + e.vatAmount)}</span>
                <span className="ltr-nums text-xs text-muted-foreground">{formatDate(e.incurredAt, fmt)}</span>
                <button className={cn("flex items-center gap-1 text-xs hover:underline", e.evidenceCount ? "text-success" : "text-warning")} onClick={() => setEvidenceFor(e)} data-testid="expense-evidence"><Paperclip className="size-3.5" /> {e.evidenceCount || t.attachEvidence}</button>
                <div className="flex flex-wrap items-center gap-1">
                  <StatusBadge status={e.status === "SUBMITTED" && e.approval?.status === "PENDING" ? "PENDING_APPROVAL" : e.status} label={e.status === "SUBMITTED" && e.approval?.status === "PENDING" ? m.enums.poStatus.PENDING_APPROVAL : m.enums.expenseStatus[e.status]} />
                  {["SUBMITTED", "REJECTED"].includes(e.status) && e.approval?.status !== "PENDING" && <Button size="xs" variant="outline" disabled={reqExp.pending || !e.evidenceCount} title={e.evidenceCount ? undefined : t.evidenceRequired} onClick={() => reqExp.run({ id: e.id })} data-testid="expense-request">{t.requestApproval}</Button>}
                  {can && e.status === "APPROVED" && <Button size="xs" variant="outline" onClick={() => paid.run({ id: e.id })}>{t.markPaid}</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`${t.changeOrders} (${data.changeOrders.length})`} actions={can && <Button size="sm" onClick={() => setDlg({ kind: "co", values: { clientVisible: true } })}><Plus /> {t.newChangeOrder}</Button>}>
        {data.changeOrders.length === 0 ? <EmptyState title={m.common.emptyTitle} /> : (
          <ul className="divide-y">
            {data.changeOrders.map((c) => (
              <li key={c.id} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_140px_140px_auto] md:items-center">
                <div><div className="text-[13px] font-medium"><span className="ltr-nums font-mono text-xs text-muted-foreground">{c.code}</span> {c.title}</div>{c.description && <div className="text-[11px] text-muted-foreground">{c.description}</div>}</div>
                <span className={cn("tabular text-xs", c.amountDelta < 0 && "text-danger")}>{t.amountDelta}: {money(c.amountDelta)}</span>
                <span className="tabular text-xs text-muted-foreground">{t.costDelta}: {money(c.costDelta)}</span>
                <div className="flex flex-wrap items-center gap-1">
                  <StatusBadge status={c.status === "PENDING" && !c.approvalId ? "DRAFT" : c.status} label={c.status === "PENDING" && !c.approvalId ? m.enums.poStatus.DRAFT : m.enums.approvalStatus[c.status]} />
                  {can && c.status === "PENDING" && !c.approvalId && <><Button size="xs" variant="outline" onClick={() => submitCo.run({ id: c.id, approverType: "INTERNAL" })}>{t.toInternal}</Button>{c.clientVisible && <Button size="xs" onClick={() => submitCo.run({ id: c.id, approverType: "CLIENT" })}>{t.toClient}</Button>}</>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {dlg && <FormDialog open onOpenChange={(o) => !o && close()} title={titles[dlg.kind]} fields={fields[dlg.kind]} values={dlg.values} onSubmit={(v) => submit(dlg.kind, v)} pending={pending} errorFor={errorFor} testId={`form-${dlg.kind}`} />}
      <Dialog open={!!evidenceFor} onOpenChange={(o) => !o && setEvidenceFor(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t.evidence} — {evidenceFor?.description}</DialogTitle></DialogHeader>
          {evidenceFor && <Attachments orgSlug={orgSlug} entityType="EXPENSE" entityId={evidenceFor.id} items={data.expenses.find((e) => e.id === evidenceFor.id)?.evidence ?? []} canUpload={["SUBMITTED", "REJECTED"].includes(evidenceFor.status)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

