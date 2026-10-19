import Link from "next/link";
import { EmptyState, PageBody, PageHeader, Section } from "@/components/app/page";
import { PriorityMark, StatusBadge } from "@/components/app/status-badge";
import { formatDate } from "@/lib/format";
import { getI18n } from "@/lib/i18n/server";
import { myWork } from "@/server/modules/tasks/service";
import { requirePageContext } from "@/server/request";

export default async function MyWorkPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  const { m, fmt, locale } = await getI18n();
  const { tasks, approvals } = await myWork(ctx);
  const now = new Date();
  const groups = [
    { key: "overdue", label: m.common.overdue, items: tasks.filter((t) => t.dueAt && t.dueAt < now) },
    { key: "week", label: m.common.dueDate + " ≤ 7", items: tasks.filter((t) => t.dueAt && t.dueAt >= now && t.dueAt.getTime() - now.getTime() < 7 * 86400_000) },
    { key: "later", label: m.common.more, items: tasks.filter((t) => !t.dueAt || t.dueAt.getTime() - now.getTime() >= 7 * 86400_000) },
  ];
  return (
    <PageBody className="max-w-5xl">
      <PageHeader title={m.tasks.myWork} description={m.tasks.myWorkDesc} />
      {approvals.length > 0 && (
        <Section title={`${m.tasks.awaitingMe} (${approvals.length})`} className="mb-4">
          <ul className="divide-y">
            {approvals.map((a) => (
              <li key={a.id}><Link href={a.entityType === "TASK" ? `/o/${org}/tasks/${a.entityId}` : `/o/${org}/projects/${a.projectId}/approvals`} className="flex items-center justify-between px-4 py-2 text-[13px] hover:bg-muted/40">{a.title}<StatusBadge status="PENDING" label={m.enums.approvalStatus.PENDING} /></Link></li>
            ))}
          </ul>
        </Section>
      )}
      {tasks.length === 0 ? <Section><EmptyState title={m.tasks.noTasks} /></Section> : (
        <div className="grid gap-4">
          {groups.filter((g) => g.items.length).map((g) => (
            <Section key={g.key} title={`${g.label} (${g.items.length})`}>
              <ul className="divide-y">
                {g.items.map((t) => (
                  <li key={t.id}>
                    <Link href={`/o/${org}/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-2 hover:bg-muted/40">
                      <StatusBadge status={t.statusCategory} label={m.enums.statusCategory[t.statusCategory]} />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{t.title}</span>
                      <span className="ltr-nums hidden text-xs text-muted-foreground md:inline">{t.project.code}-{t.number} · {(locale === "en" && t.project.nameEn) || t.project.name}</span>
                      <PriorityMark priority={t.priority} label={m.enums.priority[t.priority]} />
                      <span className={`tabular w-24 text-end text-xs ${g.key === "overdue" ? "text-danger" : "text-muted-foreground"}`}>{formatDate(t.dueAt, fmt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          ))}
        </div>
      )}
    </PageBody>
  );
}
