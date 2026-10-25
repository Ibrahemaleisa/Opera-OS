"use client";

import { useRef, useState } from "react";
import { UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/app/field";
import { Section } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { useI18n } from "@/lib/i18n/client";
import { interpolate } from "@/lib/i18n";
import { ConfirmAction } from "@/components/app/confirm-action";
import { removeMemberAction, upsertMemberAction } from "../../actions";

interface Member { userId: string; name: string; email: string; role: string; canViewFinance: boolean; canViewVip: boolean; canExport: boolean; canApprove: boolean; workstreamIds: string[] }

export function TeamClient({ orgSlug, projectId, canManage, members, people, workstreams }: { orgSlug: string; projectId: string; canManage: boolean; members: Member[]; people: { id: string; name: string; baseRole: string; roleName: string }[]; workstreams: { id: string; name: string }[] }) {
  const { m } = useI18n();
  const upsert = useAction(upsertMemberAction, { orgSlug });
  const remove = useAction(removeMemberAction, { orgSlug });
  const [newUser, setNewUser] = useState("");
  const defaultRole = (base: string) => ({ FIELD_AGENT: "FIELD_AGENT", FREELANCER: "FREELANCER", CLIENT: "CLIENT_VIEWER", CLIENT_APPROVER: "CLIENT_APPROVER", VENDOR: "VENDOR", PROJECT_MANAGER: "MANAGER", TEAM_LEAD: "LEAD" })[base] ?? "MEMBER";
  // The upsert takes the whole row, so rapid changes must not race: each change updates the row
  // locally at once, and saves for the same member run one after another, each sending the latest
  // row (two quick ticks can never send a stale value that undoes the first).
  const [local, setLocal] = useState<Record<string, Member>>({});
  const latest = useRef<Record<string, Member>>({});
  const chains = useRef<Record<string, Promise<unknown>>>({});
  const inflight = useRef<Record<string, number>>({});
  const [seenMembers, setSeenMembers] = useState(members);
  if (seenMembers !== members) {
    // fresh server data: keep local values only for rows that still have a save in flight
    setSeenMembers(members);
    setLocal((l) => Object.fromEntries(Object.entries(l).filter(([id]) => (inflight.current[id] ?? 0) > 0)));
  }
  const rowOf = (x: Member) => local[x.userId] ?? x;
  const save = (x: Member, patch: Partial<Member>) => {
    const next = { ...(latest.current[x.userId] ?? local[x.userId] ?? x), ...patch };
    latest.current[x.userId] = next;
    setLocal((l) => ({ ...l, [x.userId]: next }));
    inflight.current[x.userId] = (inflight.current[x.userId] ?? 0) + 1;
    const run = async () => {
      const row = latest.current[x.userId] ?? next;
      try {
        const r = await upsert.run({ projectId, userId: row.userId, role: row.role as never, canViewFinance: row.canViewFinance, canViewVip: row.canViewVip, canExport: row.canExport, canApprove: row.canApprove, workstreamIds: row.workstreamIds } as never);
        if (!r.ok) {
          // the server refused: show its truth again
          delete latest.current[x.userId];
          setLocal((l) => Object.fromEntries(Object.entries(l).filter(([id]) => id !== x.userId)));
        }
      } finally {
        inflight.current[x.userId] = Math.max(0, (inflight.current[x.userId] ?? 1) - 1);
        if (inflight.current[x.userId] === 0) delete latest.current[x.userId];
      }
    };
    chains.current[x.userId] = (chains.current[x.userId] ?? Promise.resolve()).then(run, run);
  };
  const caps: [keyof Member, string][] = [["canViewFinance", m.projects.capFinance], ["canViewVip", m.projects.capVip], ["canExport", m.projects.capExport], ["canApprove", m.projects.capApprove]];
  return (
    <Section
      title={`${m.projects.members} (${members.length})`}
      actions={canManage && (
        <div className="flex items-center gap-2">
          <NativeSelect className="h-8 w-56" data-testid="team-add-select" aria-label={m.projects.addMember} value={newUser} onChange={(e) => setNewUser(e.target.value)}>
            <option value="">{m.projects.addMember}…</option>
            {people.filter((p) => !members.some((x) => x.userId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.roleName}</option>)}
          </NativeSelect>
          <Button size="sm" data-testid="team-add" aria-label={m.projects.addMember} disabled={!newUser || upsert.pending} onClick={() => { const p = people.find((x) => x.id === newUser)!; upsert.run({ projectId, userId: newUser, role: defaultRole(p.baseRole) as never, canViewFinance: false, canViewVip: false, canExport: false, canApprove: false, workstreamIds: [] }).then(() => setNewUser("")); }}><UserPlus /></Button>
        </div>
      )}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-muted/60 text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="h-8 px-3 text-start font-medium">{m.common.name}</th>
              <th className="px-3 text-start font-medium">{m.common.role}</th>
              {caps.map(([, l]) => <th key={l} className="px-3 text-center font-medium">{l}</th>)}
              <th className="px-3 text-start font-medium">{m.projects.restrictWorkstreams}</th>
              <th><span className="sr-only">{m.common.actions}</span></th>
            </tr>
          </thead>
          <tbody>
            {members.map(rowOf).map((x) => (
              <tr key={x.userId} className="border-b last:border-0">
                <td className="px-3 py-2"><div className="font-medium">{x.name}</div><div className="ltr-nums text-xs text-muted-foreground">{x.email}</div></td>
                <td className="px-3 py-2">
                  <NativeSelect className="h-8 w-40" disabled={!canManage} value={x.role} onChange={(e) => save(x, { role: e.target.value })} aria-label={interpolate(m.common.a11y.roleFor, { name: x.name })}>
                    {Object.entries(m.enums.projectRole).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </NativeSelect>
                </td>
                {caps.map(([k, label]) => (
                  <td key={k} className="px-3 py-2 text-center"><Checkbox disabled={!canManage} checked={!!x[k]} onCheckedChange={(v) => save(x, { [k]: !!v })} aria-label={interpolate(m.common.a11y.permissionFor, { permission: label, name: x.name })} data-testid={`team-cap-${k}`} /></td>
                ))}
                <td className="px-3 py-2">
                  <select multiple disabled={!canManage} aria-label={interpolate(m.common.a11y.workstreamsFor, { name: x.name })} className="h-16 w-48 rounded border bg-card text-xs" value={x.workstreamIds} onChange={(e) => save(x, { workstreamIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                    {workstreams.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2">
                  {canManage && (
                    <ConfirmAction
                      trigger={<Button variant="ghost" size="icon-sm" aria-label={`${m.common.remove} — ${x.name}`}><X /></Button>}
                      title={interpolate(m.common.confirmDialog.removeMemberTitle, { name: x.name })}
                      description={m.common.confirmDialog.removeMemberBody}
                      confirmLabel={m.common.remove}
                      destructive
                      onConfirm={() => remove.run({ projectId, userId: x.userId })}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
