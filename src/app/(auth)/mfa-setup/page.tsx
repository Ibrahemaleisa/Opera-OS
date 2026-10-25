import { redirect } from "next/navigation";
import { getI18n } from "@/lib/i18n/server";
import { interpolate } from "@/lib/i18n/define";
import { db } from "@/server/db/client";
import { mfaRequirementsForUser } from "@/server/modules/auth/mfa-policy";
import { requireUser, safeNextPath } from "@/server/request";
import { MfaSetupClient } from "./mfa-setup-client";

export const metadata = { title: "Two-step verification" };

/**
 * The forced-enrolment interstitial (BUSINESS_RULES §5.2): after the grace period a privileged member
 * whose organisation requires MFA reaches only this page (and sign-out) until they set it up. During
 * grace it offers "Remind me later".
 */
export default async function MfaSetupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await requireUser();
  const { next } = await searchParams;
  const target = safeNextPath(next) ?? "/select-org";
  const u = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { mfaEnabledAt: true } });
  if (u.mfaEnabledAt) redirect(target);
  const req = await mfaRequirementsForUser(user.id, null);
  const enforced = req.some((r) => r.gate.state === "enforced");
  const daysLeft = Math.min(...req.map((r) => (r.gate.state === "grace" ? r.gate.daysLeft : Infinity)));
  const { m } = await getI18n();
  const t = m.auth.mfa;
  return (
    <div>
      <h1 className="text-2xl font-medium">{t.forcedTitle}</h1>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="mfa-forced">{enforced || !req.length ? t.forcedBody : t.graceBody}</p>
      <MfaSetupClient next={target} remindLater={!enforced && Number.isFinite(daysLeft) ? interpolate(t.remindLater, { n: daysLeft }) : null} />
    </div>
  );
}
