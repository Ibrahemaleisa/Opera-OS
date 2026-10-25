"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

/** First focusable element on every shell: jumps past the navigation to the page content. */
export function SkipLink({ targetId = "main-content" }: { targetId?: string }) {
  const { m } = useI18n();
  return (
    <a
      href={`#${targetId}`}
      className="sr-only z-[60] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-lilac focus-visible:ring-offset-2"
    >
      {m.common.a11y.skipToContent}
    </a>
  );
}

/** Notification bell link for the slim (portal/vendor) shell, with a translated accessible name. */
export function NotificationsLink({ href, unread }: { href: string; unread: number }) {
  const { m } = useI18n();
  return (
    <Link href={href} className="relative flex size-10 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-lilac focus-visible:outline-none" aria-label={unread > 0 ? `${m.common.a11y.notifications} (${unread})` : m.common.a11y.notifications}>
      <Bell aria-hidden className="size-4" />
      {unread > 0 && <span aria-hidden className="tabular absolute top-0.5 end-0.5 rounded-full bg-danger px-1 text-[10px] text-white">{unread}</span>}
    </Link>
  );
}
