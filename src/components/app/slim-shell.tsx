import Link from "next/link";
import { Bell, LogOut } from "lucide-react";
import { LocaleSwitch } from "@/app/(auth)/locale-switch";
import { logoutAction } from "@/app/actions/session";

/** Minimal shell for external users (client portal, vendor portal): no internal navigation. */
export function SlimShell({ orgName, brandColor, homeHref, title, unread, notificationsHref, signOutLabel, children }: { orgName: string; brandColor?: string | null; homeHref: string; title: string; unread: number; notificationsHref: string; signOutLabel: string; children: React.ReactNode }) {
  const brand = brandColor && /^#[0-9a-fA-F]{3,8}$/.test(brandColor) ? brandColor : undefined;
  return (
    <div className="min-h-dvh bg-muted/30">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="h-1" style={{ background: brand ?? "var(--primary)" }} />
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link href={homeHref} className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-md text-sm font-bold text-white" style={{ background: brand ?? "var(--primary)" }}>{orgName.slice(0, 1)}</span>
            <span className="grid leading-tight"><span className="text-sm font-semibold">{orgName}</span><span className="text-[11px] text-muted-foreground">{title}</span></span>
          </Link>
          <div className="ms-auto flex items-center gap-1">
            <Link href={notificationsHref} className="relative rounded-md p-2 hover:bg-muted" aria-label="notifications">
              <Bell className="size-4" />
              {unread > 0 && <span className="tabular absolute -top-0.5 -end-0.5 rounded-full bg-danger px-1 text-[10px] text-white">{unread}</span>}
            </Link>
            <LocaleSwitch />
            <form action={logoutAction}><button className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"><LogOut className="size-3.5" /> {signOutLabel}</button></form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
