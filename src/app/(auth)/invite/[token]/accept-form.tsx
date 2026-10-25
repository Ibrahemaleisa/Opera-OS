"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/app/field";
import { useI18n } from "@/lib/i18n/client";
import { acceptInviteAction } from "@/app/actions/session";

export function AcceptForm({ token, existing, defaultName }: { token: string; existing: boolean; defaultName: string }) {
  const { m, tk } = useI18n();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      // POST so a submit before hydration never puts credentials in the URL.
      method="post"
      className="mt-6 grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const r = await acceptInviteAction({ token, name: existing ? undefined : String(fd.get("name")), password: String(fd.get("password")) });
          if (r.ok) {
            router.push(r.data.redirectTo);
            router.refresh();
          } else setError(tk(r.error));
        });
      }}
    >
      {existing ? (
        <p className="text-sm text-muted-foreground">{m.auth.inviteExisting}</p>
      ) : (
        <Field label={m.auth.fullName} htmlFor="name">
          <Input id="name" name="name" defaultValue={defaultName} required />
        </Field>
      )}
      <Field label={existing ? m.auth.password : m.auth.choosePassword} hint={existing ? undefined : m.auth.passwordTooShort} htmlFor="password">
        <Input id="password" name="password" type="password" required minLength={existing ? 1 : 10} dir="ltr" autoComplete={existing ? "current-password" : "new-password"} />
      </Field>
      {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending} className="h-10">
        {m.auth.acceptInvite}
      </Button>
    </form>
  );
}
