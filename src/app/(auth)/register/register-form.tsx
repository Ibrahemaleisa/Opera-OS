"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/app/field";
import { useI18n } from "@/lib/i18n/client";
import { registerAction } from "@/app/actions/session";

function slugify(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function RegisterForm() {
  const { m, tk, locale } = useI18n();
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, start] = useTransition();
  const fe = (k: string) => (errors[k]?.[0] ? tk(errors[k][0]) : undefined);
  return (
    <form
      className="mt-8 grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setError(null);
        start(async () => {
          const r = await registerAction({
            name: String(fd.get("name")),
            email: String(fd.get("email")),
            password: String(fd.get("password")),
            orgName: String(fd.get("orgName")),
            orgSlug: String(fd.get("orgSlug")),
            locale,
          });
          if (r.ok) {
            router.push(r.data.redirectTo);
            router.refresh();
          } else {
            setErrors(r.fieldErrors ?? {});
            setError(tk(r.error));
          }
        });
      }}
    >
      <Field label={m.auth.fullName} error={fe("name")} htmlFor="name">
        <Input id="name" name="name" required autoComplete="name" />
      </Field>
      <Field label={m.auth.email} error={fe("email")} htmlFor="email">
        <Input id="email" name="email" type="email" required dir="ltr" autoComplete="email" />
      </Field>
      <Field label={m.auth.password} error={fe("password")} hint={m.auth.passwordTooShort} htmlFor="password">
        <Input id="password" name="password" type="password" required minLength={10} dir="ltr" autoComplete="new-password" />
      </Field>
      <Field label={m.auth.agencyName} error={fe("orgName")} htmlFor="orgName">
        <Input id="orgName" name="orgName" required onChange={(e) => !slugTouched && setSlug(slugify(e.target.value))} />
      </Field>
      <Field label={m.auth.agencySlug} error={fe("orgSlug")} hint={m.auth.agencySlugHint} htmlFor="orgSlug">
        <Input id="orgSlug" name="orgSlug" required dir="ltr" value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} pattern="[a-z0-9-]{3,40}" />
      </Field>
      {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending} className="h-10">
        {pending ? m.common.loading : m.auth.register}
      </Button>
    </form>
  );
}
