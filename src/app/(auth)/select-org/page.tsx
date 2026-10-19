import Link from "next/link";
import { redirect } from "next/navigation";
import { getI18n } from "@/lib/i18n/server";
import { listUserOrganizations } from "@/server/authz/load-context";
import { homePathFor } from "@/server/authz/roles";
import { requireUser } from "@/server/request";

export default async function SelectOrgPage() {
  const user = await requireUser();
  const { m, locale } = await getI18n();
  const orgs = await listUserOrganizations(user.id);
  if (orgs.length === 1) redirect(homePathFor(orgs[0].role.baseRole, orgs[0].organization.slug));
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{m.auth.chooseOrg}</h1>
      {orgs.length === 0 && <p className="mt-4 text-sm text-muted-foreground">{m.auth.noOrgs}</p>}
      <ul className="mt-6 grid gap-2">
        {orgs.map((o) => (
          <li key={o.id}>
            <Link href={homePathFor(o.role.baseRole, o.organization.slug)} className="surface flex items-center gap-3 px-4 py-3 hover:border-primary">
              <span className="flex size-8 items-center justify-center rounded-md text-sm font-bold text-white" style={{ backgroundColor: o.organization.brandColor }}>
                {o.organization.name.charAt(0)}
              </span>
              <span>
                <span className="block font-medium">{(locale === "en" && o.organization.nameEn) || o.organization.name}</span>
                <span className="text-xs text-muted-foreground">{locale === "ar" ? o.role.nameAr : o.role.nameEn}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Link href="/register" className="mt-6 inline-block text-sm text-primary hover:underline">
        + {m.auth.register}
      </Link>
    </div>
  );
}
