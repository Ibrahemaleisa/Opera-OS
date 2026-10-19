"use client";

import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
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
          <Toaster dir={locale === "ar" ? "rtl" : "ltr"} position={locale === "ar" ? "bottom-left" : "bottom-right"} richColors closeButton />
        </TooltipProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
