"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/app/field";
import { useI18n } from "@/lib/i18n/client";
import { resetPasswordAction } from "@/app/actions/session";

export function ResetForm({ token }: { token: string }) {
  const { m, tk } = useI18n();
  const t = m.auth.reset;
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [pending, start] = useTransition();
  if (invalid) {
    return (
      <div className="mt-8 grid gap-4" data-testid="reset-invalid">
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{t.invalid}</p>
        <Link href="/forgot" className="text-sm text-primary hover:underline">{t.requestNew}</Link>
      </div>
    );
  }
  return (
    <form
      method="post"
      className="mt-8 grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const password = String(fd.get("password") ?? "");
        if (password !== String(fd.get("confirm") ?? "")) return setError(t.mismatch);
        setError(null);
        start(async () => {
          const r = await resetPasswordAction({ token, password });
          if (r.ok) return router.replace(r.data.redirectTo);
          if (r.code === "TOKEN_INVALID") return setInvalid(true);
          setError(tk(r.fieldErrors?.password?.[0] ?? r.error));
        });
      }}
    >
      <Field label={t.newPassword} htmlFor="password" hint={m.auth.passwordTooShort}>
        <div className="relative">
          <Input id="password" name="password" type={show ? "text" : "password"} autoComplete="new-password" required minLength={10} dir="ltr" className="pe-10" autoFocus />
          <button type="button" onClick={() => setShow(!show)} className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground" aria-label={show ? t.hide : t.show} aria-pressed={show}>
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </Field>
      <Field label={t.confirm} htmlFor="confirm">
        <Input id="confirm" name="confirm" type={show ? "text" : "password"} autoComplete="new-password" required minLength={10} dir="ltr" />
      </Field>
      {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending} className="h-10">{pending ? m.common.loading : t.submit}</Button>
    </form>
  );
}
