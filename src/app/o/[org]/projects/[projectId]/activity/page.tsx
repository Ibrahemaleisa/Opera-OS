import { Section } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { formatDateTime } from "@/lib/format";
import { describeAudit } from "@/components/operations/describe-audit";
import { listProjectActivity } from "@/server/modules/projects/service";
import { requirePageContext } from "@/server/request";
import { guardPage } from "@/server/page-guard";

async function ActivityPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const { m, fmt } = await getI18n();
  // scoped feed: no VIP names/seats without VIP scope, no amounts without finance scope
  const events = await listProjectActivity(ctx, projectId, 300);
  return (
    <Section title={m.projects.activity}>
      <ol className="divide-y">
        {events.map((e) => {
          const d = describeAudit(e, m, fmt.locale);
          return (
            <li key={e.id} className="grid gap-0.5 px-4 py-2 text-[13px] md:grid-cols-[160px_160px_1fr]">
              <span className="tabular text-xs text-muted-foreground">{formatDateTime(e.createdAt, fmt)}</span>
              <span className="truncate font-medium"><bdi>{d.actor}</bdi></span>
              <span className="min-w-0">
                {d.title}
                {d.detail && <span className="text-muted-foreground"> · <bdi>{d.detail}</bdi></span>}
              </span>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

export default guardPage(ActivityPage);
