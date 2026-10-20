"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocaleAction } from "@/app/actions/session";
import { cn } from "@/lib/utils";

/** Switches the site language with the app's own locale action (cookie + user preference). */
export function LocaleToggle({ locale, label, className }: { locale: "ar" | "en"; label: string; className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      lang={locale === "ar" ? "en" : "ar"}
      onClick={() => start(async () => { await setLocaleAction(locale === "ar" ? "en" : "ar"); router.refresh(); })}
      className={cn("rounded-md px-2 py-1 text-sm text-mist/80 transition-colors outline-none hover:text-mist focus-visible:ring-2 focus-visible:ring-lilac disabled:opacity-60", className)}
    >
      {label}
    </button>
  );
}
