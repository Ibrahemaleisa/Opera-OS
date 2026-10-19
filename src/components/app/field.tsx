import { cn } from "@/lib/utils";

export function Field({ label, error, hint, children, className, required, htmlFor }: { label?: React.ReactNode; error?: string; hint?: React.ReactNode; children: React.ReactNode; className?: string; required?: boolean; htmlFor?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      {label && (
        <label htmlFor={htmlFor} className="field-label">
          {label}
          {required && <span className="ms-0.5 text-danger">*</span>}
        </label>
      )}
      {children}
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const selectBase =
  "h-9 w-full min-w-0 rounded-md border border-input bg-card px-2.5 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50 aria-invalid:border-destructive";

/** Native select — robust in forms and excellent on mobile. */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn(selectBase, className)} {...props} />;
}
