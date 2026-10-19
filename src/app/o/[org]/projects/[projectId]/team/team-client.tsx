"use client";

import { useState } from "react";
import { UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/app/field";
import { Section } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { useI18n } from "@/lib/i18n/client";
import { removeMemberAction, upsertMemberAction } from "../../actions";

interface Member { userId: string; name: string; email: string; role: string; canViewFinance: boolean; canViewVip: boolean; canExport: boolean; canApprove: boolean; workstreamIds: string[] }

export function TeamClient({ orgSlug, projectId, canManage, members, people, workstreams }: { orgSlug: string; projectId: string; canManage: boolean; members: Member[]; people: { id: string; name: string; baseRole: string; roleName: string }[]; workstreams: { id: string; name: string }[] }) {
  const { m } = useI18n();
  const upsert = useAction(upsertMemberAction, { orgSlug });
  const remove = useAction(removeMemberAction, { orgSlug });
  const [newUser, setNewUser] = useState("");
  const defaultRole = (base: string) => ({ FIELD_AGENT: "FIELD_AGENT", FREELANCER: "FREELANCER", CLIENT: "CLIENT_VIEWER", CLIENT_APPROVER: "CLIENT_APPROVER", VENDOR: "VENDOR", PROJECT_MANAGER: "MANAGER", TEAM_LEAD: "LEAD" })[base] ?? "MEMBER";
  const save = (x: Member, patch: Partial<Member>) => upsert.run({ projectId, userId: x.userId, role: x.role as never, canViewFinance: x.canViewFinance, canViewVip: x.canViewVip, canExport: x.canExport, canApprove: x.canApprove, workstreamIds: x.workstreamIds, ...patch } as never);
  const caps: [keyof Member, string][] = [["canViewFinance", m.projects.capFinance], ["canViewVip", m.projects.capVip], ["canExport", m.projects.capExport], ["canApprove", m.projects.capApprove]];
  return (
    <Section
      title={`${m.projects.members} (${members.length})`}
      actions={canManage && (
        <div className="flex items-center gap-2">
          <NativeSelect className="h-8 w-56" value={newUser} onChange={(e) => setNewUser(e.target.value)}>
            <option value="">{m.projects.addMember}…</option>
            {people.filter((p) => !members.some((x) => x.userId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.roleName}</option>)}
          </NativeSelect>
          <Button size="sm" disabled={!newUser || upsert.pending} onClick={() => { const p = people.find((x) => x.id === newUser)!; upsert.run({ projectId, userId: newUser, role: defaultRole(p.baseRole) as never, canViewFinance: false, canViewVip: false, canExport: false, canApprove: false, workstreamIds: [] }).then(() => setNewUser("")); }}><UserPlus /></Button>
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
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((x) => (
              <tr key={x.userId} className="border-b last:border-0">
                <td className="px-3 py-2"><div className="font-medium">{x.name}</div><div className="ltr-nums text-xs text-muted-foreground">{x.email}</div></td>
                <td className="px-3 py-2">
                  <NativeSelect className="h-8 w-40" disabled={!canManage} value={x.role} onChange={(e) => save(x, { role: e.target.value })}>
                    {Object.entries(m.enums.projectRole).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </NativeSelect>
                </td>
                {caps.map(([k]) => (
                  <td key={k} className="px-3 py-2 text-center"><Checkbox disabled={!canManage} checked={!!x[k]} onCheckedChange={(v) => save(x, { [k]: !!v })} /></td>
                ))}
                <td className="px-3 py-2">
                  <select multiple disabled={!canManage} className="h-16 w-48 rounded border bg-card text-xs" value={x.workstreamIds} onChange={(e) => save(x, { workstreamIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                    {workstreams.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2">{canManage && <Button variant="ghost" size="icon-sm" onClick={() => remove.run({ projectId, userId: x.userId })} aria-label={m.common.remove}><X /></Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
