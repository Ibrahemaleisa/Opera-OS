"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/app/field";
import { useI18n } from "@/lib/i18n/client";
import { loginAction } from "@/app/actions/session";

export function LoginForm({ next }: { next?: string }) {
  const { m, tk } = useI18n();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      // POST so a submit before hydration never puts credentials in the URL.
      method="post"
      className="mt-8 grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setError(null);
        start(async () => {
          const r = await loginAction({ email: String(fd.get("email")), password: String(fd.get("password")), next });
          if (r.ok) {
            router.push(r.data.redirectTo);
            router.refresh();
          } else setError(tk(r.error));
        });
      }}
    >
      <Field label={m.auth.email} htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required dir="ltr" />
      </Field>
      <Field label={m.auth.password} htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required dir="ltr" />
      </Field>
      {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending} className="h-10">
        {pending ? m.common.loading : m.auth.signIn}
      </Button>
    </form>
  );
}
