"use client";

import { createContext, useContext, useMemo } from "react";
import type { CalendarPref } from "@/lib/format";
import { getMessages, translateKey, type Locale, type Messages } from "./index";

interface I18nValue {
  locale: Locale;
  calendar: CalendarPref;
  dir: "rtl" | "ltr";
  m: Messages;
  tk: (key: string, vars?: Record<string, string | number | null | undefined>) => string;
  fmt: { locale: Locale; calendar: CalendarPref };
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ locale, calendar, children }: { locale: Locale; calendar: CalendarPref; children: React.ReactNode }) {
  const value = useMemo<I18nValue>(() => {
    const m = getMessages(locale);
    return { locale, calendar, dir: locale === "ar" ? "rtl" : "ltr", m, tk: (k, v) => translateKey(m, k, v), fmt: { locale, calendar } };
  }, [locale, calendar]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
