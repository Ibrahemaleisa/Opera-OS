"use client";

import { ThemeProvider } from "next-themes";
import { CircleAlert } from "lucide-react";
import { Toaster } from "sonner";
import { OperaSymbol } from "@/components/brand/logo";
import { Spinner } from "@/components/brand/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n";
import type { CalendarPref } from "@/lib/format";

export function Providers({ locale, calendar, children }: { locale: Locale; calendar: CalendarPref; children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <I18nProvider locale={locale} calendar={calendar}>
        <TooltipProvider delayDuration={250}>
          {children}
          <Toaster
            dir={locale === "ar" ? "rtl" : "ltr"}
            position={locale === "ar" ? "bottom-left" : "bottom-right"}
            closeButton
            // Brand toast: Plum ground, Mist text, the ring marks a completed action
            style={{ "--normal-bg": "var(--plum)", "--normal-text": "var(--mist)", "--normal-border": "var(--plum)", "--border-radius": "12px" } as React.CSSProperties}
            toastOptions={{ classNames: { description: "!text-mist/75", actionButton: "!bg-transparent !text-lilac !font-medium", cancelButton: "!bg-transparent !text-mist/70" } }}
            icons={{ success: <OperaSymbol tone="light" className="size-4" />, error: <CircleAlert className="size-4 text-error-on-dark" />, loading: <Spinner className="text-lilac" /> }}
          />
        </TooltipProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
