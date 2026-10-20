import { cn } from "@/lib/utils";

/** Loading indicator: the open brand ring turning. Inherits the text colour. */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0 animate-spin", className)} role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d="M8.6 3.6A9 9 0 1 1 3.6 8.6" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" />
    </svg>
  );
}
