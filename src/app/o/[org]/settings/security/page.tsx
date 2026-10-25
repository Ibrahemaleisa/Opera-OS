import { PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan, can } from "@/server/authz/policy";
import { getSecuritySettings } from "@/server/modules/auth/mfa-policy";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";
import { SecurityClient } from "./security-client";

/** Settings → Security: the organisation's MFA policy (BUSINESS_RULES §5.2). Owners change it; directors see it. */
async function SecurityPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "org.manage");
  const { m } = await getI18n();
  const data = await getSecuritySettings(ctx);
  return (
    <>
      <PageHeader title={m.auth.security.title} description={m.auth.security.description} />
      <SecurityClient
        orgSlug={org}
        data={{ ...data, members: data.members.map((x) => ({ ...x, gate: x.gate.state === "grace" ? { state: "grace" as const, daysLeft: x.gate.daysLeft } : { state: x.gate.state } })) }}
        canManageMembers={can(ctx, "org.members.manage")}
        isOwner={ctx.role === "OWNER"}
      />
    </>
  );
}

export default guardPage(SecurityPage);
