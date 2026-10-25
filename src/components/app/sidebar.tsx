"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bell,
  Boxes,
  Building2,
  CalendarDays,
  ClipboardList,
  Crown,
  FileSpreadsheet,
  FolderKanban,
  Hammer,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  MapPin,
  Package,
  Send,
  Settings,
  ShieldCheck,
  Truck,
  Users,
  UsersRound,
  Wallet,
  Workflow,
  Store,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/client";

export const ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  projects: FolderKanban,
  myWork: ListChecks,
  templates: LayoutTemplate,
  delivery: Package,
  recipients: UsersRound,
  imports: FileSpreadsheet,
  dispatch: Truck,
  digital: Send,
  events: CalendarDays,
  protocol: Crown,
  booths: Hammer,
  vendors: Store,
  resources: Boxes,
  finance: Wallet,
  reports: BarChart3,
  notifications: Bell,
  members: Users,
  clients: Building2,
  venues: MapPin,
  automation: Workflow,
  audit: ShieldCheck,
  settings: Settings,
  tasks: ClipboardList,
};

export interface NavItem {
  key: string;
  label: string;
  href: string;
  badge?: number;
}
export interface NavSection {
  label: string;
  items: NavItem[];
}

export function SidebarNav({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const { m } = useI18n();
  const pathname = usePathname();
  // longest-prefix match so /o/x/projects/123 highlights Projects, not Dashboard
  const all = sections.flatMap((s) => s.items);
  const active = all
    .filter((i) => pathname === i.href || pathname.startsWith(i.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav aria-label={m.common.a11y.mainNav} className="flex flex-col gap-4 px-2 pt-2 pb-4">
      {sections.map((s) => (
        <div key={s.label}>
          <div className="eyebrow mb-1 px-2 !text-sidebar-muted">{s.label}</div>
          <ul className="flex flex-col gap-px">
            {s.items.map((item) => {
              const Icon = ICONS[item.key] ?? LayoutDashboard;
              const isActive = item.href === active;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "group relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-sidebar-foreground/80 transition-colors outline-none hover:bg-sidebar-active/60 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-lilac",
                      isActive && "bg-sidebar-active font-medium text-sidebar-foreground",
                    )}
                  >
                    <Icon className={cn("size-4 shrink-0 text-sidebar-muted", isActive && "text-sidebar-dot")} />
                    <span className="truncate">{item.label}</span>
                    {!!item.badge && <span className="tabular ms-auto rounded-full bg-lilac px-1.5 text-[10px] leading-4 font-medium text-plum">{item.badge > 99 ? "99+" : item.badge}</span>}
                    {/* the dot: "you are here" */}
                    {isActive && <span className={cn("size-1.5 shrink-0 rounded-full bg-sidebar-dot", !item.badge && "ms-auto")} aria-hidden />}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
