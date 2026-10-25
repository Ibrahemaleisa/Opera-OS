"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { TimeAgo } from "@/components/app/time-ago";
import { ConfirmAction } from "@/components/app/confirm-action";
import { ExceptionChip } from "@/components/operations/exception-chip";
import { useAction } from "@/hooks/use-action";
import { useI18n } from "@/lib/i18n/client";
import type { listProjectApprovals } from "@/server/modules/approvals/service";
import { decideApprovalAction, withdrawApprovalAction } from "../../actions";

type Row = Awaited<ReturnType<typeof listProjectApprovals>>["approvals"][number];

/** Project approvals: decide (only where the caller is an eligible approver) or withdraw a pending request. */
export function ApprovalsList({ orgSlug, approvals, users }: { orgSlug: string; approvals: Row[]; users: Record<string, string> }) {
  const { m } = useI18n();
  const nameOf = (id: string | null) => (id ? users[id] ?? "—" : "—");
  return (
    <Section title={m.projects.approvals}>
      <ul className="divide-y">
        {approvals.map((a) => (
          <li key={a.id} className="grid gap-2 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-medium">{a.title}</span>
              <span className="flex flex-wrap items-center justify-end gap-1.5">
                {a.policyException && <ExceptionChip testId="approval-exception-chip">{m.tasks.policy.selfApproved}</ExceptionChip>}
                {a.noEligibleApprover && <ExceptionChip testId="approval-no-approver">{m.tasks.policy.noEligibleApprover}</ExceptionChip>}
                <StatusBadge status={a.status} label={m.enums.approvalStatus[a.status]} />
              </span>
            </div>
            {a.policyException && a.policyExceptionReason && <p className="text-[11px] text-muted-foreground"><bdi>{a.policyExceptionReason}</bdi></p>}
            <ol className="grid gap-1 border-s ps-3 text-[11px] text-muted-foreground">
              {a.decisions.map((d) => (
                <li key={d.id}><span className="text-foreground">{nameOf(d.actorId)}</span> · {m.enums.approvalStatus[d.decision]}{d.comment && <span> — “{d.comment}”</span>} · <TimeAgo date={d.createdAt} /></li>
              ))}
            </ol>
            {a.canDecide && <Decide orgSlug={orgSlug} approvalId={a.id} />}
            {a.canSelfApprove && <SelfApprove orgSlug={orgSlug} approvalId={a.id} />}
            {a.canWithdraw && <Withdraw orgSlug={orgSlug} approvalId={a.id} />}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Decide({ orgSlug, approvalId }: { orgSlug: string; approvalId: string }) {
  const { m } = useI18n();
  const decide = useAction(decideApprovalAction, { orgSlug });
  const [comment, setComment] = useState("");
  return (
    <div className="grid gap-2">
      <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={m.tasks.decisionComment} rows={2} />
      <div className="flex gap-2">
        <Button size="sm" disabled={decide.pending} onClick={() => decide.run({ approvalId, decision: "APPROVED", comment: comment || null })}>{m.tasks.approve}</Button>
        <Button size="sm" variant="outline" disabled={decide.pending || !comment.trim()} title={m.tasks.rejectNeedsComment} onClick={() => decide.run({ approvalId, decision: "REJECTED", comment })}>{m.tasks.reject}</Button>
      </div>
    </div>
  );
}

/** §4.3: the requester decides their own request under the exception, with a justification and an explicit confirmation. */
function SelfApprove({ orgSlug, approvalId }: { orgSlug: string; approvalId: string }) {
  const { m } = useI18n();
  const P = m.tasks.policy;
  const decide = useAction(decideApprovalAction, { orgSlug });
  return (
    <div>
      <ConfirmAction
        trigger={<Button size="sm" variant="outline" className="border-warning/40 bg-warning-soft text-warning hover:bg-warning-soft/80" data-testid="approval-self-approve">{P.selfApprove}</Button>}
        title={P.selfApprove}
        description={P.selfApproveDesc}
        confirmLabel={P.selfApprove}
        field={{ type: "textarea", label: P.justification, required: true, hint: P.justificationHint }}
        onConfirm={async (justification) => decide.run({ approvalId, decision: "APPROVED", comment: null, exception: { justification, confirm: true } })}
        testId="self-approve-dialog"
      />
    </div>
  );
}

function Withdraw({ orgSlug, approvalId }: { orgSlug: string; approvalId: string }) {
  const { m } = useI18n();
  const withdraw = useAction(withdrawApprovalAction, { orgSlug, onSuccess: () => setOpen(false) });
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <div>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid="approval-withdraw">{m.tasks.withdraw}</Button>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={m.tasks.withdrawReason} rows={2} aria-label={m.tasks.withdrawReason} />
      <p className="text-[11px] text-muted-foreground">{m.tasks.withdrawHint}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={withdraw.pending || reason.trim().length < 3} onClick={() => withdraw.run({ approvalId, reason })}>{m.tasks.withdraw}</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{m.common.cancel}</Button>
      </div>
    </div>
  );
}
