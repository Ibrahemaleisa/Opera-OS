"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/app/field";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { beginMfaAction, confirmMfaAction } from "./actions";

type Step = 0 | 1 | 2 | 3;

/** The step line (import-wizard chip style): numbered chips, the current one in violet. */
export function StepLine({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="steps">
      {steps.map((label, i) => (
        <li key={label} className="flex items-center gap-1.5" aria-current={i === current ? "step" : undefined}>
          <span className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1", i === current ? "border-primary bg-brand-soft text-primary" : i < current ? "border-transparent bg-success-soft text-success" : "text-muted-foreground")}>
            <span className="ltr-nums tabular font-medium">{i < current ? <Check className="size-3" /> : i + 1}</span>
            {label}
          </span>
          {i < steps.length - 1 && <span className="h-px w-3 bg-border" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

/** Recovery codes, shown once: 2-column mono grid, copy and download, and a required "saved" checkbox. */
export function RecoveryCodes({ codes, onDone, doneLabel }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const { m } = useI18n();
  const t = m.auth.mfa;
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");
  return (
    <div className="grid gap-4" data-testid="recovery-codes">
      <p className="text-sm text-muted-foreground">{t.codesBody}</p>
      <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-3 font-mono text-sm" dir="ltr">
        {codes.map((c) => <li key={c} className="ltr-nums tracking-wider" data-testid="recovery-code">{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); }}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? t.copied : t.copy}
        </Button>
        <Button asChild size="sm" variant="outline">
          <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(`Opera recovery codes\n\n${text}\n`)}`} download="opera-recovery-codes.txt"><Download className="size-3.5" /> {t.download}</a>
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} data-testid="codes-saved" />
        {t.saved}
      </label>
      <Button type="button" disabled={!saved} onClick={onDone}>{doneLabel ?? t.done}</Button>
    </div>
  );
}

/**
 * Two-step verification set-up (BUSINESS_RULES §5.2): a quick password check, then scan the QR (or
 * type the key), enter one code, and save the 10 recovery codes shown once. Done.
 */
export function MfaEnrolment({ onDone }: { onDone: () => void }) {
  const { m, tk } = useI18n();
  const t = m.auth.mfa;
  const [step, setStep] = useState<Step>(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  // three visible steps: scan, enter a code, save the codes. Re-entering the password (BUSINESS_RULES
  // §5.2) is a quiet check before them, not a step of its own.
  const steps = [t.steps.scan, t.steps.confirm, t.steps.codes];

  return (
    <div className="grid gap-5" data-testid="mfa-enrolment">
      {step > 0 && <StepLine steps={steps} current={step - 1} />}
      {step === 0 && (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const password = String(new FormData(e.currentTarget).get("password") ?? "");
            setError(null);
            start(async () => {
              const r = await beginMfaAction({ password });
              if (!r.ok) return setError(tk(r.fieldErrors?.password?.[0] ?? r.error));
              setSetup(r.data);
              setStep(1);
            });
          }}
        >
          <p className="text-sm text-muted-foreground">{t.passwordPrompt}</p>
          <Field label={m.auth.password} htmlFor="mfa-password">
            <Input id="mfa-password" name="password" type="password" autoComplete="current-password" required dir="ltr" autoFocus />
          </Field>
          {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          <Button type="submit" disabled={pending}>{pending ? m.common.loading : t.continue}</Button>
        </form>
      )}
      {step === 1 && setup && (
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">{t.scanBody}</p>
          {/* the QR always sits on a white tile, whatever the theme */}
          <div className="justify-self-center rounded-lg bg-white p-3 shadow-xs">
            {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL generated on the server */}
            <img src={setup.qr} alt="" width={192} height={192} className="size-48" data-testid="mfa-qr" />
          </div>
          <div className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">{t.manualKey}</span>
            <div className="flex items-center gap-2">
              <code className="ltr-nums flex-1 rounded-md border bg-muted/30 px-3 py-2 font-mono text-sm tracking-wider break-all" dir="ltr" data-testid="mfa-secret">{setup.secret.match(/.{1,4}/g)?.join(" ")}</code>
              <Button type="button" size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(setup.secret); setCopied(true); }}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? t.copied : t.copy}
              </Button>
            </div>
          </div>
          <Button type="button" onClick={() => setStep(2)}>{t.continue}</Button>
        </div>
      )}
      {step === 2 && (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const code = String(new FormData(e.currentTarget).get("code") ?? "").replace(/\s/g, "");
            setError(null);
            start(async () => {
              const r = await confirmMfaAction({ code });
              if (!r.ok) return setError(tk(r.fieldErrors?.code?.[0] ?? r.error));
              setCodes(r.data.recoveryCodes);
              setStep(3);
            });
          }}
        >
          <Field label={t.codeLabel} htmlFor="mfa-code">
            <Input id="mfa-code" name="code" required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} dir="ltr" className="ltr-nums font-mono text-lg tracking-[0.3em]" />
          </Field>
          {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setStep(1)}>{m.common.back}</Button>
            <Button type="submit" disabled={pending} className="flex-1">{pending ? m.common.loading : t.verify}</Button>
          </div>
        </form>
      )}
      {step === 3 && <RecoveryCodes codes={codes} onDone={onDone} />}
    </div>
  );
}
