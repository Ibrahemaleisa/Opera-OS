import { getI18n } from "@/lib/i18n/server";
import { interpolate } from "@/lib/i18n";
import { resolveInvitation } from "@/server/modules/auth/service";
import { AcceptForm } from "./accept-form";

export const metadata = { title: "Invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { m, locale } = await getI18n();
  const inv = await resolveInvitation(token);
  if (!inv) {
    return (
      <div>
        <h1 className="text-xl font-semibold">{m.errors.tokenInvalid}</h1>
      </div>
    );
  }
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{interpolate(m.auth.inviteTitle, { org: inv.org.name })}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{interpolate(m.auth.inviteSubtitle, { role: locale === "ar" ? inv.role.nameAr : inv.role.nameEn })}</p>
      <p className="ltr-nums mt-3 text-sm">{inv.invitation.email}</p>
      <AcceptForm token={token} existing={inv.existingUser} defaultName={inv.invitation.name ?? ""} />
    </div>
  );
}
