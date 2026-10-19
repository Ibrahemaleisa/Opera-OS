import { Section } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { formatDate } from "@/lib/format";
import { getProjectOverview } from "@/server/modules/projects/service";
import { listTemplates } from "@/server/modules/templates/service";
import { requirePageContext } from "@/server/request";
import { ApplyTemplate } from "./apply-template";

export default async function WorkstreamsPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  const ctx = await requirePageContext(org);
  const { m, fmt, locale } = await getI18n();
  const o = await getProjectOverview(ctx, projectId);
  const templates = o.scope.manage ? await listTemplates(ctx) : [];
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid content-start gap-4">
        {o.workstreams.map((w) => {
          const inst = o.instances.find((i) => i.id === w.templateInstanceId);
          const statuses = (w.statuses as { key: string; ar: string; en: string; category: string }[]) ?? [];
          return (
            <Section key={w.id} title={<span className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ backgroundColor: w.color ?? "var(--muted-foreground)" }} />{(locale === "en" && w.nameEn) || w.name}</span>} description={`${m.enums.workstreamKind[w.kind]} · ${w.key}${inst ? ` · ${inst.templateKey} v${inst.versionNumber}` : ""}`}>
              <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
                {statuses.map((s) => <span key={s.key} className="rounded-full bg-muted px-2 py-0.5 text-[11px]">{locale === "en" ? s.en : s.ar}</span>)}
                <span className="tabular ms-auto text-xs text-muted-foreground">{w.done}/{w.total} {m.projects.tasks}</span>
              </div>
            </Section>
          );
        })}
      </div>
      <div className="grid content-start gap-4">
        <Section title={m.projects.templates}>
          <ul className="divide-y">
            {o.instances.map((i) => (
              <li key={i.id} className="px-4 py-2 text-[13px]"><span className="ltr-nums font-mono text-xs">{i.templateKey}</span> <span className="text-muted-foreground">v{i.versionNumber} · {formatDate(i.appliedAt, fmt)}</span></li>
            ))}
          </ul>
        </Section>
        {o.scope.manage && <ApplyTemplate orgSlug={org} projectId={projectId} templates={templates.map((t) => ({ id: t.id, name: locale === "ar" ? t.nameAr : t.nameEn, version: t.latestVersion }))} />}
      </div>
    </div>
  );
}
