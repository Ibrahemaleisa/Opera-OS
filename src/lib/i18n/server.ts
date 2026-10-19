import { cookies } from "next/headers";
import { cache } from "react";
import { DEFAULT_LOCALE, dirFor, getMessages, isLocale, LOCALE_COOKIE, type Locale } from "./index";
import type { CalendarPref } from "@/lib/format";

export const getLocale = cache(async (): Promise<Locale> => {
  const store = await cookies();
  const v = store.get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
});

export const getCalendar = cache(async (): Promise<CalendarPref> => {
  const store = await cookies();
  return store.get("operra_calendar")?.value === "islamic-umalqura" ? "islamic-umalqura" : "gregory";
});

export async function getI18n() {
  const locale = await getLocale();
  const calendar = await getCalendar();
  return { locale, dir: dirFor(locale), m: getMessages(locale), calendar, fmt: { locale, calendar } as const };
}
