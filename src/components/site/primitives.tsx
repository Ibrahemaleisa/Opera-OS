import { cn } from "@/lib/utils";

/** 12-column page frame shared by every section. */
export function Container({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-[1320px] px-5 sm:px-8 lg:px-12", className)}>{children}</div>;
}

/** Section index — "01 · Who we are" — on a hairline, in the brand's label style. */
export function SectionMark({ index, label, className }: { index: string; label: string; className?: string }) {
  return (
    <div className={cn("flex items-baseline gap-4 border-t border-current/15 pt-5", className)}>
      <span className="tabular text-sm text-current/55">{index}</span>
      <span className="eyebrow !text-[12px] !text-current/70">{label}</span>
    </div>
  );
}
