"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/app/field";
import { DateText } from "@/components/app/date-text";
import { useI18n } from "@/lib/i18n/client";
import { interpolate } from "@/lib/i18n/define";
import { disableMfaAction, regenerateCodesAction } from "./actions";
import { MfaEnrolment, RecoveryCodes } from "./mfa-enrolment";

export interface MfaStatusView {
  enabled: boolean;
  enabledAt: Date | null;
  recoveryLeft: number;
  lowOnCodes: boolean;
  canDisable: boolean;
}

/** Password + current code, for "regenerate codes" and "turn off". */
function CredentialsDialog({ open, onOpenChange, title, body, confirmLabel, destructive, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; body: string; confirmLabel: string; destructive?: boolean; onSubmit: (v: { password: string; code: string }) => Promise<string | null> }) {
  const { m } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && (setError(null), onOpenChange(o))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <form
          id="mfa-credentials"
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            start(async () => setError(await onSubmit({ password: String(fd.get("password") ?? ""), code: String(fd.get("code") ?? "").replace(/\s/g, "") })));
          }}
        >
          <Field label={m.auth.password} htmlFor="cred-password"><Input id="cred-password" name="password" type="password" autoComplete="current-password" required dir="ltr" /></Field>
          <Field label={m.auth.mfa.codeLabel} htmlFor="cred-code"><Input id="cred-code" name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={7} dir="ltr" className="ltr-nums font-mono tracking-[0.3em]" /></Field>
          {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        </form>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>{m.common.cancel}</Button>
          <Button type="submit" form="mfa-credentials" variant={destructive ? "destructive" : "default"} disabled={pending}>{pending ? m.common.loading : confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** /account → "Two-step verification" (UX note 6). */
export function MfaSection({ status, requiredByOrg, recoveryNotice }: { status: MfaStatusView; requiredByOrg: boolean; recoveryNotice: boolean }) {
  const { m, tk } = useI18n();
  const t = m.auth.mfa;
  const router = useRouter();
  const [enrol, setEnrol] = useState(false);
  const [regen, setRegen] = useState(false);
  const [off, setOff] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const fieldError = (r: { ok: false; error: string; fieldErrors?: Record<string, string[]> }) => tk(r.fieldErrors?.code?.[0] ?? r.fieldErrors?.password?.[0] ?? r.error);
  return (
    <section className="rounded-xl border bg-card" data-testid="mfa-section">
      <h2 className="border-b px-4 py-2.5 text-sm font-medium">{t.title}</h2>
      <div className="grid gap-3 p-4 text-sm">
        {(recoveryNotice || status.lowOnCodes) && status.enabled && (
          <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-warning" data-testid="recovery-low">{interpolate(t.recoveryLow, { n: status.recoveryLeft })}</p>
        )}
        {status.enabled ? (
          <>
            <p className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-success" aria-hidden />
              <span>
                {t.onSummary.split("{date}")[0]}
                <DateText value={status.enabledAt} />
                {t.onSummary.split("{date}")[1]?.replace("{n}", String(status.recoveryLeft))}
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setRegen(true)}>{t.regenerate}</Button>
              <Button size="sm" variant="ghost" className="text-danger" disabled={!status.canDisable} onClick={() => setOff(true)}>{t.turnOff}</Button>
            </div>
            {!status.canDisable && <p className="text-xs text-muted-foreground">{t.requiredByOrg}</p>}
          </>
        ) : (
          <>
            <p className="text-muted-foreground">{t.offBody}</p>
            {requiredByOrg && <p className="text-xs text-warning">{t.requiredByOrg}</p>}
            <div><Button size="sm" onClick={() => setEnrol(true)} data-testid="mfa-setup">{t.setUp}</Button></div>
          </>
        )}
      </div>
      <Dialog open={enrol} onOpenChange={setEnrol}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>{t.title}</DialogTitle></DialogHeader>
          <MfaEnrolment onDone={() => { setEnrol(false); toast.success(t.enabledToast); router.refresh(); }} />
        </DialogContent>
      </Dialog>
      <CredentialsDialog
        open={regen && !newCodes}
        onOpenChange={setRegen}
        title={t.regenerate}
        body={t.regenerateBody}
        confirmLabel={t.regenerate}
        onSubmit={async (v) => {
          const r = await regenerateCodesAction(v);
          if (!r.ok) return fieldError(r);
          setNewCodes(r.data.recoveryCodes);
          toast.success(t.regeneratedToast);
          return null;
        }}
      />
      <Dialog open={!!newCodes} onOpenChange={(o) => !o && (setNewCodes(null), setRegen(false), router.refresh())}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{t.steps.codes}</DialogTitle></DialogHeader>
          {newCodes && <RecoveryCodes codes={newCodes} onDone={() => { setNewCodes(null); setRegen(false); router.refresh(); }} />}
        </DialogContent>
      </Dialog>
      <CredentialsDialog
        open={off}
        onOpenChange={setOff}
        title={t.turnOffTitle}
        body={t.turnOffBody}
        confirmLabel={t.turnOff}
        destructive
        onSubmit={async (v) => {
          const r = await disableMfaAction(v);
          if (!r.ok) return fieldError(r);
          setOff(false);
          toast.success(t.disabledToast);
          router.refresh();
          return null;
        }}
      />
    </section>
  );
}
