"use client";

import { FlaskConical, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { useI18n } from "@/lib/i18n/client";
import { setProviderModeAction } from "@/app/o/[org]/digital/actions";

type Ch = { channel: "EMAIL" | "SMS" | "WHATSAPP"; mode: string; liveProvider: string | null; senderId: string | null };

export function ProvidersClient({ orgSlug, channels, suppressions, canManage }: { orgSlug: string; channels: Ch[]; suppressions: number; canManage: boolean }) {
  const { m } = useI18n();
  const dg = m.digital;
  const set = useAction(setProviderModeAction, { orgSlug });
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        {channels.map((c) => (
          <Section key={c.channel} title={m.enums.channel[c.channel]}>
            <div className="grid gap-3 p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{dg.mode}</span>
                {c.mode === "LIVE" ? (
                  <span className="flex items-center gap-1 rounded bg-success-soft px-2 py-0.5 text-xs text-success"><Radio className="size-3" /> LIVE · {c.liveProvider}</span>
                ) : (
                  <span className="flex items-center gap-1 rounded bg-violet-soft px-2 py-0.5 text-xs text-violet" data-testid={`provider-${c.channel}-sim`}><FlaskConical className="size-3" /> {m.common.simulation}</span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{dg.credentials}</span>
                <span className={`text-xs ${c.liveProvider ? "text-success" : "text-warning"}`}>{c.liveProvider ? `${dg.credentialsPresent} (${c.liveProvider})` : dg.credentialsMissing}</span>
              </div>
              {canManage && (
                <div>
                  {c.mode === "LIVE" ? (
                    <Button size="sm" variant="outline" disabled={set.pending} onClick={() => set.run({ channel: c.channel, mode: "SIMULATION", senderId: c.senderId })}>{dg.setSimulation}</Button>
                  ) : (
                    <Button size="sm" disabled={set.pending || !c.liveProvider} onClick={() => set.run({ channel: c.channel, mode: "LIVE", senderId: c.senderId })}>{dg.setLive}</Button>
                  )}
                </div>
              )}
            </div>
          </Section>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">{dg.suppressionCount}: <span className="ltr-nums font-medium text-foreground">{suppressions}</span></p>
    </div>
  );
}
