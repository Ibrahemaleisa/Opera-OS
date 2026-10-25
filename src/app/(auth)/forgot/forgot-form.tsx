"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/app/field";
import { useI18n } from "@/lib/i18n/client";
import { forgotPasswordAction } from "@/app/actions/session";

/** Always the same answer, whether or not the account exists (BUSINESS_RULES §5.1). */
export function ForgotForm({ email }: { email: string }) {
  const { m } = useI18n();
  const t = m.auth.forgot;
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();
  if (sent) {
    return (
      <div className="mt-8 grid gap-4">
        <p role="status" className="rounded-md bg-success-soft px-3 py-2 text-sm text-success" data-testid="forgot-sent">{t.sent}</p>
        <Link href="/login" className="text-sm text-primary hover:underline">{t.back}</Link>
      </div>
    );
  }
  return (
    <form
      method="post"
      className="mt-8 grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const value = String(new FormData(e.currentTarget).get("email") ?? "");
        start(async () => {
          await forgotPasswordAction({ email: value });
          setSent(true);
        });
      }}
    >
      <Field label={m.auth.email} htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required dir="ltr" defaultValue={email} autoFocus />
      </Field>
      <Button type="submit" disabled={pending} className="h-10">{pending ? m.common.loading : t.submit}</Button>
      <Link href="/login" className="justify-self-start text-sm text-primary hover:underline">{t.back}</Link>
    </form>
  );
}
