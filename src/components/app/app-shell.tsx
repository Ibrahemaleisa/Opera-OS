"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState, useTransition } from "react";
import { Bell, CalendarRange, Check, ChevronsUpDown, Globe, LogOut, Menu, Moon, Search, Sun, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "@/lib/i18n/client";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { logoutAction, setCalendarAction, setLocaleAction } from "@/app/actions/session";
import { markReadAction, notificationsAction } from "@/app/actions/shell";
import { CommandPalette } from "./command-palette";
import { SidebarNav, type NavSection } from "./sidebar";

export interface ShellProps {
  org: { slug: string; name: string; brandColor: string };
  user: { name: string; email: string; roleLabel: string };
  orgs: { slug: string; name: string; brandColor: string }[];
  nav: NavSection[];
  unread: number;
  children: React.ReactNode;
}

function OrgMark({ name, color, className }: { name: string; color: string; className?: string }) {
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md text-[13px] font-bold text-white", className)} style={{ backgroundColor: color }}>
      {name.trim().charAt(0)}
    </span>
  );
}

export function AppShell({ org, user, orgs, nav, unread, children }: ShellProps) {
  const { m, locale } = useI18n();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center border-b border-sidebar-border px-3">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-start hover:bg-sidebar-active/70">
            <OrgMark name={org.name} color={org.brandColor} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">{org.name}</span>
              <span className="block truncate text-[11px] text-sidebar-muted">{m.common.appName} · {m.common.appTagline}</span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-muted" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="text-xs text-muted-foreground">{m.shell.workspaces}</DropdownMenuLabel>
            {orgs.map((o) => (
              <DropdownMenuItem key={o.slug} asChild>
                <a href={`/o/${o.slug}`} className="flex items-center gap-2">
                  <OrgMark name={o.name} color={o.brandColor} className="size-5 text-[10px]" />
                  <span className="truncate">{o.name}</span>
                  {o.slug === org.slug && <Check className="ms-auto size-3.5" />}
                </a>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex-1 overflow-y-auto">
        <SidebarNav sections={nav} onNavigate={() => setMobileOpen(false)} />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="no-print sticky top-0 hidden h-dvh w-60 shrink-0 border-e border-sidebar-border bg-sidebar text-sidebar-foreground lg:block">{sidebar}</aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side={locale === "ar" ? "right" : "left"} className="w-72 bg-sidebar p-0 text-sidebar-foreground">
          <SheetTitle className="sr-only">{m.shell.menu}</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:px-5">
          <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label={m.shell.menu}>
            <Menu />
          </Button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 w-full max-w-md items-center gap-2 rounded-md border bg-card px-2.5 text-start text-sm text-muted-foreground shadow-xs transition-colors hover:border-input"
          >
            <Search className="size-3.5" />
            <span className="flex-1 truncate">{m.shell.searchAnything}</span>
            <span className="kbd hidden sm:inline-flex">⌘K</span>
          </button>
          <div className="ms-auto flex items-center gap-1">
            <PreferenceButtons />
            <NotificationBell orgSlug={org.slug} initialUnread={unread} />
            <UserMenu user={user} />
          </div>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      <CommandPalette orgSlug={org.slug} open={paletteOpen} onOpenChange={setPaletteOpen} nav={nav} />
    </div>
  );
}

function PreferenceButtons() {
  const { m, locale, calendar } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const router = useRouter();
  const [, start] = useTransition();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2 text-xs"
        title={m.common.language}
        onClick={() => start(async () => { await setLocaleAction(locale === "ar" ? "en" : "ar"); router.refresh(); })}
      >
        <Globe className="size-3.5" />
        <span className="hidden sm:inline">{m.shell.switchLanguage}</span>
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title={m.shell.toggleCalendar}
        aria-label={m.shell.toggleCalendar}
        onClick={() => start(async () => { await setCalendarAction(calendar === "gregory" ? "islamic-umalqura" : "gregory"); router.refresh(); })}
        className={cn(calendar === "islamic-umalqura" && "text-primary")}
      >
        <CalendarRange />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={m.shell.toggleTheme} onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
        {mounted && resolvedTheme === "dark" ? <Sun /> : <Moon />}
      </Button>
    </>
  );
}

interface NotificationItem {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}

function NotificationBell({ orgSlug, initialUnread }: { orgSlug: string; initialUnread: number }) {
  const { m, tk, fmt } = useI18n();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(initialUnread);
  useEffect(() => setUnread(initialUnread), [initialUnread]);

  useEffect(() => {
    if (!open) return;
    notificationsAction(orgSlug, { unreadOnly: false }).then((r) => {
      if (r.ok) {
        setItems(r.data.items as NotificationItem[]);
        setUnread(r.data.unread);
      }
    });
  }, [open, orgSlug]);

  // light polling for new notifications while the tab is visible
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      notificationsAction(orgSlug, { unreadOnly: true }).then((r) => r.ok && setUnread(r.data.unread));
    }, 45_000);
    return () => clearInterval(id);
  }, [orgSlug]);

  const markAll = async () => {
    await markReadAction(orgSlug, {});
    setUnread(0);
    setItems((xs) => xs.map((x) => ({ ...x, readAt: x.readAt ?? new Date() })));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative" aria-label={m.shell.openNotifications}>
          <Bell />
          {unread > 0 && <span className="tabular absolute -top-0.5 -end-0.5 min-w-4 rounded-full bg-danger px-1 text-[9px] leading-4 font-bold text-white">{unread > 99 ? "99+" : unread}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">{m.notif.title}</span>
          {unread > 0 && (
            <button className="text-xs text-primary hover:underline" onClick={markAll}>
              {m.shell.markAllRead}
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 && <p className="px-3 py-8 text-center text-xs text-muted-foreground">{m.shell.noNotifications}</p>}
          {items.map((n) => {
            const params = n.body ? (JSON.parse(n.body) as Record<string, string>) : undefined;
            return (
              <Link
                key={n.id}
                href={n.link ? `/o/${orgSlug}${n.link}` : `/o/${orgSlug}/notifications`}
                onClick={() => { setOpen(false); if (!n.readAt) markReadAction(orgSlug, { ids: [n.id] }); }}
                className={cn("flex gap-2 border-b px-3 py-2.5 last:border-0 hover:bg-muted/50", !n.readAt && "bg-jade-soft/40")}
              >
                <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-primary")} />
                <span className="min-w-0">
                  <span className="block text-[13px] leading-snug">{tk(n.title, params)}</span>
                  <span className="text-[11px] text-muted-foreground">{formatRelative(n.createdAt, fmt)}</span>
                </span>
              </Link>
            );
          })}
        </div>
        <Link href={`/o/${orgSlug}/notifications`} onClick={() => setOpen(false)} className="block border-t px-3 py-2 text-center text-xs text-primary hover:bg-muted/50">
          {m.shell.viewAll}
        </Link>
      </PopoverContent>
    </Popover>
  );
}

function UserMenu({ user }: { user: { name: string; email: string; roleLabel: string } }) {
  const { m } = useI18n();
  const initials = user.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="ms-1 flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground" aria-label={m.common.profile}>
        {initials}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>
          <div className="text-[13px] font-medium">{user.name}</div>
          <div className="text-xs font-normal text-muted-foreground">{user.email}</div>
          <div className="mt-1 text-[11px] font-normal text-primary">{user.roleLabel}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <User className="size-4" /> {m.common.profile}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => logoutAction()}>
          <LogOut className="size-4" /> {m.common.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
