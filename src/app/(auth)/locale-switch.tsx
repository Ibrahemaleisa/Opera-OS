"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/client";
import { setLocaleAction } from "@/app/actions/session";

export function LocaleSwitch() {
  const { m, locale } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant="ghost" size="sm" disabled={pending} onClick={() => start(async () => { await setLocaleAction(locale === "ar" ? "en" : "ar"); router.refresh(); })}>
      <Globe className="size-3.5" /> {m.shell.switchLanguage}
    </Button>
  );
}
