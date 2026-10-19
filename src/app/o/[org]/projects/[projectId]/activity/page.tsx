import { Section } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { formatDateTime } from "@/lib/format";
import { projectScope } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";
import { NotFoundError } from "@/server/errors";
import { requirePageContext } from "@/server/request";

export default async function ActivityPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const { m, fmt } = await getI18n();
  const events = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const s = await projectScope(tx, ctx, projectId);
    if (s.clientView || s.fieldOnly) throw new NotFoundError();
    return tx.auditEvent.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 300 });
  });
  return (
    <Section title={m.projects.activity}>
      <ol className="divide-y">
        {events.map((e) => (
          <li key={e.id} className="grid gap-0.5 px-4 py-2 text-[13px] md:grid-cols-[160px_160px_1fr]">
            <span className="tabular text-xs text-muted-foreground">{formatDateTime(e.createdAt, fmt)}</span>
            <span className="font-medium">{e.actorName ?? "—"}</span>
            <span><span className="ltr-nums font-mono text-xs text-muted-foreground">{e.action}</span>{e.summary && <span className="ms-2">{e.summary}</span>}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
