import { cn } from "@/lib/utils";

/** Accessible horizontal bar list — label + bar + value; no chart library needed. */
export function BarList({ items, className, format }: { items: { key: string; label: string; value: number; tone?: string }[]; className?: string; format?: (n: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className={cn("grid gap-2", className)}>
      {items.map((i) => (
        <li key={i.key} className="grid grid-cols-[minmax(90px,35%)_1fr_auto] items-center gap-2 text-[12.5px]">
          <span className="truncate text-muted-foreground">{i.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary" style={{ width: `${(i.value / max) * 100}%`, backgroundColor: i.tone }} /></span>
          <span className="tabular w-10 text-end font-medium">{format ? format(i.value) : i.value}</span>
        </li>
      ))}
    </ul>
  );
}
