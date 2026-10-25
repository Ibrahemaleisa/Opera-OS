"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/app/field";
import { useI18n } from "@/lib/i18n/client";
import { loginAction, verifyMfaAction } from "@/app/actions/session";

/**
 * Sign-in in two steps: password, then — when the account has two-step verification — a code from
 * the authenticator app or a recovery code (BUSINESS_RULES §5.2). Both forms POST, so a submit before
 * hydration never puts credentials in the URL.
 */
export function LoginForm({ next }: { next?: string }) {
  const { m, tk } = useI18n();
  const t = m.auth.mfa;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"password" | "code">("password");
  const [recovery, setRecovery] = useState(false);
  const [pending, start] = useTransition();
  const codeRef = useRef<HTMLInputElement>(null);
  const go = (to: string) => {
    router.push(to);
    router.refresh();
  };

  if (step === "code") {
    return (
      <form
        method="post"
        className="mt-8 grid gap-4"
        data-testid="mfa-step"
        onSubmit={(e) => {
          e.preventDefault();
          const value = String(new FormData(e.currentTarget).get("code") ?? "").trim();
          setError(null);
          start(async () => {
            const r = await verifyMfaAction(recovery ? { recoveryCode: value, next } : { code: value, next });
            if (r.ok) return go(r.data.redirectTo);
            setError(tk(r.error));
            if ("restart" in r && r.restart) {
              setStep("password");
              setRecovery(false);
            } else codeRef.current?.select();
          });
        }}
      >
        <div>
          <h2 className="text-lg font-medium">{t.enterCode}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{recovery ? t.enterRecoveryBody : t.enterCodeBody}</p>
        </div>
        <Field label={recovery ? t.recoveryLabel : t.codeLabel} htmlFor="code">
          {recovery ? (
            <Input key="recovery" ref={codeRef} id="code" name="code" required autoFocus autoComplete="off" dir="ltr" placeholder="xxxx-xxxx" className="ltr-nums font-mono tracking-wider" maxLength={20} />
          ) : (
            <Input key="totp" ref={codeRef} id="code" name="code" required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} dir="ltr" className="ltr-nums font-mono text-lg tracking-[0.3em]" />
          )}
        </Field>
        {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <Button type="submit" disabled={pending} className="h-10">
          {pending ? m.common.loading : t.verify}
        </Button>
        <button type="button" className="justify-self-start text-sm text-primary hover:underline" onClick={() => { setRecovery(!recovery); setError(null); }}>
          {recovery ? t.useApp : t.useRecovery}
        </button>
      </form>
    );
  }

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
          if (!r.ok) return setError(tk(r.error));
          if ("step" in r.data) return setStep("code");
          go(r.data.redirectTo);
        });
      }}
    >
      <Field label={m.auth.email} htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required dir="ltr" />
      </Field>
      <Field label={m.auth.password} htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required dir="ltr" />
      </Field>
      <Link href="/forgot" className="-mt-2 justify-self-start text-sm text-primary hover:underline">
        {m.auth.forgotLink}
      </Link>
      {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending} className="h-10">
        {pending ? m.common.loading : m.auth.signIn}
      </Button>
    </form>
  );
}
