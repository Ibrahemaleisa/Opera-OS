"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/app/field";
import { TimeAgo } from "@/components/app/time-ago";
import { useI18n } from "@/lib/i18n/client";
import { revokeDeviceAction } from "@/app/actions/session";
import { changePasswordAction, updateProfileAction } from "./actions";

interface U { name: string; nameAr: string | null; phone: string | null; locale: string; calendar: string }
interface S { id: string; deviceLabel: string | null; ip: string | null; lastSeenAt: Date; current: boolean }

export function AccountForms({ user, sessions }: { user: U; sessions: S[] }) {
  const { m, tk } = useI18n();
  const t = m.auth.account;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const err = (f: string) => (errors[f]?.[0] ? tk(errors[f][0]) : undefined);
  const handle = (r: { ok: boolean; error?: string; fieldErrors?: Record<string, string[]> }, okMsg: string) => {
    if (r.ok) { setErrors({}); toast.success(okMsg); router.refresh(); }
    else { setErrors(r.fieldErrors ?? {}); toast.error(tk(r.error ?? "errors.unexpected")); }
  };
  return (
    <>
      <section className="rounded-xl border bg-card">
        <h2 className="border-b px-4 py-2.5 text-sm font-medium">{t.profile}</h2>
        <form className="grid gap-3 p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); start(async () => handle(await updateProfileAction(Object.fromEntries(fd)), m.common.saved)); }}>
          <Field label={m.common.nameEn} error={err("name")} required><Input name="name" defaultValue={user.name} required dir="ltr" /></Field>
          <Field label={m.common.nameAr}><Input name="nameAr" defaultValue={user.nameAr ?? ""} /></Field>
          <Field label={m.common.phone}><Input name="phone" defaultValue={user.phone ?? ""} dir="ltr" type="tel" /></Field>
          <Field label={t.language}><NativeSelect name="locale" defaultValue={user.locale}><option value="ar">العربية</option><option value="en">English</option></NativeSelect></Field>
          <Field label={t.calendar}><NativeSelect name="calendar" defaultValue={user.calendar}><option value="gregory">{t.gregorian}</option><option value="islamic-umalqura">{t.hijri}</option></NativeSelect></Field>
          <div className="flex items-end"><Button type="submit" disabled={pending}>{m.common.save}</Button></div>
        </form>
      </section>
      <section className="rounded-xl border bg-card">
        <h2 className="border-b px-4 py-2.5 text-sm font-medium">{t.password}</h2>
        <form className="grid gap-3 p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const fd = new FormData(form); start(async () => { const r = await changePasswordAction(Object.fromEntries(fd)); handle(r, t.changed); if (r.ok) form.reset(); }); }}>
          <Field label={t.current} error={err("current")}><Input name="current" type="password" autoComplete="current-password" required dir="ltr" /></Field>
          <Field label={t.next} error={err("next")} hint={m.auth.passwordTooShort}><Input name="next" type="password" autoComplete="new-password" required minLength={10} dir="ltr" /></Field>
          <div><Button type="submit" variant="outline" disabled={pending}>{t.password}</Button></div>
        </form>
      </section>
      <section className="rounded-xl border bg-card">
        <h2 className="border-b px-4 py-2.5 text-sm font-medium">{t.sessions} ({sessions.length})</h2>
        <ul className="divide-y">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm" data-testid="session-row">
              <span className="flex-1">{s.deviceLabel ?? "—"}{s.current && <span className="ms-2 rounded bg-brand-soft px-1.5 text-[10px] text-primary">{t.thisDevice}</span>}</span>
              <span className="ltr-nums text-xs text-muted-foreground">{s.ip ?? ""} · {t.lastSeen} <TimeAgo date={s.lastSeenAt} /></span>
              {!s.current && <Button size="xs" variant="ghost" className="text-danger" disabled={pending} onClick={() => start(async () => handle(await revokeDeviceAction(s.id), m.common.saved))}>{t.revoke}</Button>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
