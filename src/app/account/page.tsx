import Link from "next/link";
import { getI18n } from "@/lib/i18n/server";
import { getAccount } from "@/server/auth/account";
import { requireUser } from "@/server/request";
import { listMySessions } from "@/app/actions/session";
import { AccountForms } from "./account-forms";
import { MfaSection } from "./mfa-section";
import { getMfaStatus } from "@/server/modules/auth/mfa";

export const metadata = { title: "Account" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ recovery?: string }> }) {
  const user = await requireUser();
  const { recovery } = await searchParams;
  const { m, locale } = await getI18n();
  const [account, sessions, mfa] = await Promise.all([getAccount(user.id), listMySessions(), getMfaStatus(user.id)]);
  const t = m.auth.account;
  return (
    <div className="min-h-dvh bg-muted/30">
      <div className="mx-auto grid max-w-3xl gap-5 px-4 py-8">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-medium">{t.title}</h1>
          <span className="ltr-nums text-sm text-muted-foreground">{account.user.email}</span>
        </div>
        {account.memberships.length > 0 && (
          <section className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-2.5 text-sm font-medium">{t.orgs}</h2>
            <ul className="divide-y">
              {account.memberships.map((o) => (
                <li key={o.id} className="flex items-center gap-2 px-4 py-2.5 text-sm"><span className="flex-1">{(locale === "en" && o.nameEn) || o.name}<span className="ms-2 text-xs text-muted-foreground">{locale === "en" ? o.role.nameEn : o.role.nameAr}</span></span><Link className="text-xs text-primary hover:underline" href={`/o/${o.slug}`}>{t.open}</Link></li>
              ))}
            </ul>
          </section>
        )}
        <MfaSection status={mfa} requiredByOrg={mfa.requiredBy.length > 0} recoveryNotice={recovery === "low"} />
        <AccountForms user={account.user} sessions={sessions} />
      </div>
    </div>
  );
}
