import { PageHeader, Section } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { formatDateTime } from "@/lib/format";
import { listAudit } from "@/server/modules/org/service";
import { requirePageContext } from "@/server/request";
import { assertCan } from "@/server/authz/policy";
import { guardPage } from "@/server/page-guard";

async function AuditPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ action?: string; entity?: string; cursor?: string }> }) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "org.audit.view");
  const { m, fmt } = await getI18n();
  const events = await listAudit(ctx, { action: sp.action, entityType: sp.entity, cursor: sp.cursor, take: 100 });
  const last = events.at(-1);
  return (
    <>
      <PageHeader title={m.org.auditTitle} description={m.org.auditDesc} />
      <form className="mb-3 flex flex-wrap gap-2" method="get">
        <input name="action" defaultValue={sp.action} placeholder={`${m.org.action} (delivery., import., member.)`} className="h-8 w-64 rounded-md border bg-card px-2.5 text-sm" dir="ltr" />
        <input name="entity" defaultValue={sp.entity} placeholder={`${m.org.entity} (DELIVERY, PROJECT…)`} className="h-8 w-56 rounded-md border bg-card px-2.5 text-sm" dir="ltr" />
        <button className="h-8 rounded-md border bg-card px-3 text-sm">{m.common.filter}</button>
      </form>
      <Section>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-muted/60 text-xs text-muted-foreground">
              <tr className="border-b">
                {[m.common.date, m.org.actor, m.org.action, m.org.entity, m.org.summary, m.org.ip].map((h) => <th key={h} className="h-8 px-3 text-start font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b last:border-0 align-top">
                  <td className="tabular px-3 py-2 whitespace-nowrap text-muted-foreground">{formatDateTime(e.createdAt, fmt)}</td>
                  <td className="px-3 py-2">{e.actorName ?? "—"}</td>
                  <td className="ltr-nums px-3 py-2 font-mono text-xs">{e.action}</td>
                  <td className="ltr-nums px-3 py-2 text-xs text-muted-foreground">{e.entityType}{e.entityId ? ` · ${e.entityId.slice(-8)}` : ""}</td>
                  <td className="max-w-md px-3 py-2 break-words">{e.summary ?? (e.after ? <code className="text-[11px] text-muted-foreground">{JSON.stringify(e.after).slice(0, 160)}</code> : "—")}</td>
                  <td className="ltr-nums px-3 py-2 text-xs text-muted-foreground">{e.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{m.common.noResults}</p>}
        </div>
        {events.length === 100 && last && (
          <div className="border-t px-3 py-2 text-end"><a className="text-xs text-primary" href={`?${new URLSearchParams({ ...(sp.action ? { action: sp.action } : {}), ...(sp.entity ? { entity: sp.entity } : {}), cursor: last.id })}`}>{m.common.next}</a></div>
        )}
      </Section>
    </>
  );
}

export default guardPage(AuditPage);
