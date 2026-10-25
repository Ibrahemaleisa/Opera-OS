import { GapMark } from "@/components/brand/gap-mark";
import { cn } from "@/lib/utils";

/**
 * "Done under an explicit policy exception" (UX note 0): the gap mark with words on warning-soft.
 * Never colour alone; used for self-approvals under the small-organisation exception and for
 * projects closed with an override.
 */
export function ExceptionChip({ children, className, testId }: { children: React.ReactNode; className?: string; testId?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning", className)} data-testid={testId}>
      <GapMark size={11} />
      {children}
    </span>
  );
}
