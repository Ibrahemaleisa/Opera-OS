import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items, dir = "rtl" }: { items: Crumb[]; dir?: "rtl" | "ltr" }) {
  const Sep = dir === "rtl" ? ChevronLeft : ChevronRight;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      {items.map((c, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <Sep className="size-3 shrink-0 opacity-60" />}
          {c.href ? (
            <Link href={c.href} className="truncate hover:text-foreground">
              {c.label}
            </Link>
          ) : (
            <span className="truncate text-foreground/80">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function PageHeader({ title, description, actions, crumbs, dir, meta, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; crumbs?: Crumb[]; dir?: "rtl" | "ltr"; meta?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-5 flex flex-col gap-3", className)}>
      {crumbs && crumbs.length > 0 && <Breadcrumbs items={crumbs} dir={dir} />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[1600px] px-4 py-5 md:px-6 md:py-6", className)}>{children}</div>;
}

export function Section({ title, actions, children, className, description }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; description?: React.ReactNode }) {
  return (
    <section className={cn("surface", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
          <div>
            {title && <h2 className="section-title">{title}</h2>}
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div>{children}</div>
    </section>
  );
}

export function EmptyState({ icon, title, body, action, className }: { icon?: React.ReactNode; title: React.ReactNode; body?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {body && <p className="mt-1 max-w-md text-xs text-muted-foreground">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone, icon, href }: { label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode; tone?: "default" | "success" | "warning" | "danger"; icon?: React.ReactNode; href?: string }) {
  const body = (
    <div className="surface @container flex h-full flex-col gap-1 px-4 py-3 transition-colors hover:border-input">
      <div className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
        <span className="line-clamp-2 leading-snug">{label}</span>
        {icon && <span className="shrink-0 opacity-70 [&_svg]:size-4">{icon}</span>}
      </div>
      <div
        className={cn(
          // figures never break mid-number: the size steps down with the tile instead, and a line
          // may only wrap between the amount and its currency
          "tabular mt-auto text-lg font-medium @[11rem]:text-xl @[14rem]:text-2xl",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export function KV({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(110px,40%)_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function ProgressBar({ value, className, tone = "brand" }: { value: number; className?: string; tone?: "brand" | "success" | "warning" | "danger" }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const color = { brand: "bg-primary", success: "bg-success", warning: "bg-warning", danger: "bg-danger" }[tone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-chart-track", className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full transition-[width]", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}
