import { PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan } from "@/server/authz/policy";
import { listClients } from "@/server/modules/org/service";
import { requirePageContext } from "@/server/request";
import { ClientsClient } from "./clients-client";

export default async function ClientsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "org.directory.manage");
  const { m } = await getI18n();
  const clients = await listClients(ctx);
  return (
    <>
      <PageHeader title={m.org.clientsTitle} description={m.org.clientsDesc} />
      <ClientsClient orgSlug={org} clients={clients.map((c) => ({ ...c, projects: c._count.projects, createdAt: undefined, updatedAt: undefined, contacts: c.contacts.map((x) => ({ id: x.id, name: x.name, title: x.title, email: x.email, phone: x.phone, isPrimary: x.isPrimary })) }))} />
    </>
  );
}
