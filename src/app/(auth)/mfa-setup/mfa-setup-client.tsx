"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { logoutAction } from "@/app/actions/session";
import { MfaEnrolment } from "@/app/account/mfa-enrolment";

export function MfaSetupClient({ next, remindLater }: { next: string; remindLater: string | null }) {
  const { m } = useI18n();
  const router = useRouter();
  return (
    <div className="mt-8 grid gap-6">
      <MfaEnrolment onDone={() => { router.push(next); router.refresh(); }} />
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-sm">
        {remindLater ? <Link href={next} className="text-primary hover:underline" data-testid="mfa-remind-later">{remindLater}</Link> : <span />}
        <form action={logoutAction}>
          <button type="submit" className="text-muted-foreground hover:text-foreground">{m.auth.mfa.signOut}</button>
        </form>
      </div>
    </div>
  );
}
