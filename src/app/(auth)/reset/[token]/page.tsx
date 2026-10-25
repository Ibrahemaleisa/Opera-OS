import type { Metadata } from "next";
import Link from "next/link";
import { getI18n } from "@/lib/i18n/server";
import { resetTokenValid } from "@/server/modules/auth/password-reset";
import { ResetForm } from "./reset-form";

// the token is in the URL: never send it on as a referrer, never index the page
export const metadata: Metadata = { title: "Set a new password", referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { m } = await getI18n();
  const t = m.auth.reset;
  if (!(await resetTokenValid(token))) {
    // neutral: no detail on why (expired, used, unknown)
    return (
      <div data-testid="reset-invalid">
        <h1 className="text-2xl font-medium">{t.invalidTitle}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t.invalid}</p>
        <Link href="/forgot" className="mt-6 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">{t.requestNew}</Link>
      </div>
    );
  }
  return (
    <div>
      <h1 className="text-2xl font-medium">{t.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t.subtitle}</p>
      <ResetForm token={token} />
    </div>
  );
}
