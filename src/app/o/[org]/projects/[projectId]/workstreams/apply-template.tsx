"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/app/field";
import { Section } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { interpolate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import type { CompositionPreview } from "@/server/modules/templates/service";
import { applyTemplateAction, previewTemplateAction } from "../../actions";

export function ApplyTemplate({ orgSlug, projectId, templates }: { orgSlug: string; projectId: string; templates: { id: string; name: string; version: number }[] }) {
  const { m } = useI18n();
  const [templateId, setTemplateId] = useState("");
  const [preview, setPreview] = useState<CompositionPreview | null>(null);
  const prev = useAction(previewTemplateAction, { orgSlug, success: false, refresh: false, onSuccess: setPreview });
  const apply = useAction(applyTemplateAction, { orgSlug, success: m.projects.applied, onSuccess: () => { setPreview(null); setTemplateId(""); } });
  return (
    <Section title={m.projects.applyTemplate}>
      <div className="grid gap-3 p-4">
        <NativeSelect value={templateId} onChange={(e) => { setTemplateId(e.target.value); setPreview(null); if (e.target.value) prev.run({ projectId, templateId: e.target.value }); }}>
          <option value="">—</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name} · v{t.version}</option>)}
        </NativeSelect>
        {preview && (
          <div className="grid gap-2 rounded-md border p-3 text-xs">
            <div className="font-medium">{m.projects.applyPreview}</div>
            <div className="tabular text-muted-foreground">{interpolate(m.projects.wizard.composeSummary, { workstreams: preview.stats.workstreams, tasks: preview.stats.tasks + preview.stats.subtasks, milestones: preview.stats.milestones })}</div>
            {preview.workstreams.filter((w) => w.collision).map((w) => (
              <div key={w.key} className="flex items-center gap-1 text-warning"><AlertTriangle className="size-3.5" />{interpolate(m.projects.collision, { key: w.resolvedKey })}</div>
            ))}
            <Button size="sm" disabled={apply.pending} onClick={() => apply.run({ projectId, templateId })}>{m.common.apply}</Button>
          </div>
        )}
      </div>
    </Section>
  );
}
