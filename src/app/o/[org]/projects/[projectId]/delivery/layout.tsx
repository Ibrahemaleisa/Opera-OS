import { TabNav } from "@/components/app/tab-nav";
import { getI18n } from "@/lib/i18n/server";

export default async function DeliveryLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const { m } = await getI18n();
  const b = `/o/${org}/projects/${projectId}/delivery`;
  return (
    <div className="grid gap-4">
      <TabNav
        className="border-b-0"
        items={[
          { href: b, label: m.projects.overview, exact: true },
          { href: `${b}/cards`, label: m.delivery.cards },
          { href: `${b}/recipients`, label: m.delivery.registry.title },
          { href: `${b}/imports`, label: m.delivery.import.title },
          { href: `/o/${org}/dispatch?project=${projectId}`, label: m.delivery.dispatch.title },
        ]}
      />
      {children}
    </div>
  );
}
