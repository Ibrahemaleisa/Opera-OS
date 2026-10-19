import { cn } from "@/lib/utils";

export type Tone = "neutral" | "jade" | "success" | "warning" | "danger" | "info" | "violet" | "muted";

const TONES: Record<Tone, string> = {
  neutral: "bg-secondary text-secondary-foreground",
  muted: "bg-muted text-muted-foreground",
  jade: "bg-jade-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  violet: "bg-violet-soft text-violet",
};

const DOT: Record<Tone, string> = {
  neutral: "bg-foreground/40",
  muted: "bg-muted-foreground/50",
  jade: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  violet: "bg-violet",
};

/** Semantic status → tone. Shared across modules so colors mean the same thing everywhere. */
const STATUS_TONES: Record<string, Tone> = {
  // generic
  DRAFT: "muted", PENDING: "neutral", PLANNING: "info", PLANNED: "neutral", ACTIVE: "jade", OPEN: "info", IN_PROGRESS: "jade", ON_HOLD: "warning", AT_RISK: "danger",
  COMPLETED: "success", CLOSED: "muted", CANCELLED: "muted", DONE: "success", TODO: "neutral", BLOCKED: "danger", REVIEW: "violet",
  APPROVED: "success", REJECTED: "danger", PENDING_APPROVAL: "warning", SUBMITTED: "violet", SUPERSEDED: "muted",
  // delivery
  VALIDATING: "info", READY: "neutral", ASSIGNED: "violet", OUT_FOR_DELIVERY: "info", DELIVERED: "success", FAILED_ATTEMPT: "danger", RESCHEDULED: "warning", RETURNED: "warning",
  // import
  UPLOADED: "neutral", PARSED: "info", VALIDATED: "jade", COMMITTING: "info", COMMITTED: "success", PARTIALLY_COMMITTED: "warning", FAILED: "danger", ROLLED_BACK: "muted",
  VALID: "success", WARNING: "warning", INVALID: "danger", DUPLICATE: "violet", SKIPPED: "muted",
  // messages
  QUEUED: "neutral", SENDING: "info", SENT: "jade", READ: "success", SUPPRESSED: "muted", SCHEDULED: "info",
  ATTENDING: "success", DECLINED: "danger", MAYBE: "warning",
  // events
  SETUP: "info", REHEARSAL: "violet", LIVE: "danger", TEARDOWN: "warning", ACKNOWLEDGED: "violet", RESOLVED: "success",
  EXPECTED: "neutral", CONFIRMED: "jade", ARRIVED: "success", SEATED: "success", DEPARTED: "muted", NO_SHOW: "danger", ISSUE: "danger", STANDBY: "warning", GO: "danger",
  // priority / severity
  LOW: "muted", MEDIUM: "neutral", HIGH: "warning", CRITICAL: "danger",
  // members
  INVITED: "info", SUSPENDED: "warning", REVOKED: "muted",
  // finance
  ISSUED: "info", RECEIVED: "success", PAID: "success", PARTIALLY_RECEIVED: "warning", SHORTLISTED: "violet", ACCEPTED: "success", REQUESTED: "neutral", EXPIRED: "muted",
  // execution
  RUNNING: "info", SUCCEEDED: "success",
  UNVERIFIED: "neutral", VERIFIED: "success",
  PASS: "success", FAIL: "danger", CONDITIONAL: "warning", FIXED: "success",
};

export function toneFor(status: string | null | undefined): Tone {
  if (!status) return "muted";
  return STATUS_TONES[status] ?? STATUS_TONES[status.toUpperCase()] ?? "neutral";
}

export function StatusBadge({ status, label, tone, dot = true, className }: { status?: string | null; label: React.ReactNode; tone?: Tone; dot?: boolean; className?: string }) {
  const t = tone ?? toneFor(status);
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium whitespace-nowrap", TONES[t], className)}>
      {dot && <span className={cn("size-1.5 rounded-full", DOT[t])} />}
      {label}
    </span>
  );
}

export function PriorityMark({ priority, label }: { priority: string; label: string }) {
  const bars = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[priority] ?? 2;
  const color = priority === "CRITICAL" ? "bg-danger" : priority === "HIGH" ? "bg-warning" : "bg-muted-foreground/60";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={label}>
      <span className="flex h-3 items-end gap-px" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn("w-[3px] rounded-sm", i <= bars ? color : "bg-border")} style={{ height: `${i * 3}px` }} />
        ))}
      </span>
      <span className="sr-only sm:not-sr-only">{label}</span>
    </span>
  );
}
