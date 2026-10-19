"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function TabNav({ items, className }: { items: { href: string; label: string; exact?: boolean; count?: number }[]; className?: string }) {
  const pathname = usePathname();
  const active = items
    .filter((i) => (i.exact ? pathname === i.href : pathname === i.href || pathname.startsWith(i.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav className={cn("-mb-px flex gap-1 overflow-x-auto border-b", className)}>
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          className={cn(
            "flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground",
            i.href === active && "border-primary font-medium text-foreground",
          )}
        >
          {i.label}
          {i.count !== undefined && <span className="tabular rounded-full bg-muted px-1.5 text-[10px]">{i.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
