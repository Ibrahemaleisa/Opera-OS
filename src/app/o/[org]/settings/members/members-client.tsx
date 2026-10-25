"use client";

import { useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, MailPlus, MoreHorizontal, ShieldPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/app/data-table";
import { Field, NativeSelect } from "@/components/app/field";
import { Section } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { useAction } from "@/hooks/use-action";
import { formObject } from "@/lib/form";
import { formatDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { TimeAgo } from "@/components/app/time-ago";
import { ConfirmAction } from "@/components/app/confirm-action";
import { interpolate } from "@/lib/i18n";
import { changeRoleAction, inviteMemberAction, revokeInvitationAction, saveRoleAction, setMemberStatusAction } from "../actions";

interface Member { id: string; userId: string; name: string; nameEn: string; email: string; status: string; roleId: string; baseRole: string; lastLoginAt: string | null; clientId: string | null; vendorId: string | null }
interface Role { id: string; key: string; nameAr: string; nameEn: string; baseRole: string; isSystem: boolean; permissions: string[] }
interface Props {
  orgSlug: string;
  canManage: boolean;
  canManageRoles: boolean;
  currentUserId: string;
  members: Member[];
  invitations: { id: string; email: string; roleId: string; expiresAt: string }[];
  roles: Role[];
  clients: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  projects: { id: string; name: string; code: string }[];
  permissionCatalog: string[];
}

export function MembersClient(p: Props) {
  const { m, locale, fmt } = useI18n();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleEdit, setRoleEdit] = useState<Role | "new" | null>(null);
  const roleName = (id: string) => {
    const r = p.roles.find((x) => x.id === id);
    return r ? (locale === "ar" ? r.nameAr : r.nameEn) : "—";
  };
  const changeRole = useAction(changeRoleAction, { orgSlug: p.orgSlug });
  const setStatus = useAction(setMemberStatusAction, { orgSlug: p.orgSlug });
  const revokeInv = useAction(revokeInvitationAction, { orgSlug: p.orgSlug });
  // suspend / revoke are confirmed first; focus goes back to the row's actions button afterwards
  const [statusAsk, setStatusAsk] = useState<{ member: Member; status: "SUSPENDED" | "REVOKED" } | null>(null);
  const askedFor = useRef<string | null>(null);
  const ask = (member: Member, status: "SUSPENDED" | "REVOKED") => {
    askedFor.current = member.id;
    setStatusAsk({ member, status });
  };

  const columns = useMemo<ColumnDef<Member, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: m.common.name,
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="font-medium">{locale === "ar" ? row.original.name : row.original.nameEn}</div>
            <div className="ltr-nums text-xs text-muted-foreground">{row.original.email}</div>
          </div>
        ),
      },
      {
        accessorKey: "roleId",
        header: m.common.role,
        cell: ({ row }) =>
          p.canManage && row.original.userId !== p.currentUserId ? (
            <NativeSelect
              className="h-8 w-48"
              value={row.original.roleId}
              onChange={(e) => changeRole.run({ membershipId: row.original.id, roleId: e.target.value })}
              disabled={changeRole.pending}
              aria-label={m.org.changeRole}
            >
              {p.roles.map((r) => (
                <option key={r.id} value={r.id}>{locale === "ar" ? r.nameAr : r.nameEn}</option>
              ))}
            </NativeSelect>
          ) : (
            roleName(row.original.roleId)
          ),
      },
      { accessorKey: "status", header: m.common.status, cell: ({ row }) => <StatusBadge status={row.original.status} label={m.enums.memberStatus[row.original.status as keyof typeof m.enums.memberStatus]} /> },
      { accessorKey: "lastLoginAt", header: m.org.lastLogin, cell: ({ row }) => <span className="text-xs text-muted-foreground"><TimeAgo date={row.original.lastLoginAt} /></span> },
      {
        id: "actions",
        header: "",
        size: 40,
        cell: ({ row }) =>
          p.canManage && row.original.userId !== p.currentUserId ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`${m.common.actions} — ${locale === "ar" ? row.original.name : row.original.nameEn}`} data-member-actions={row.original.id}><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {row.original.status === "ACTIVE" ? (
                  <DropdownMenuItem onSelect={() => ask(row.original, "SUSPENDED")}>{m.org.suspend}</DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => setStatus.run({ membershipId: row.original.id, status: "ACTIVE" })}>{m.org.activate}</DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onSelect={() => ask(row.original, "REVOKED")}>{m.org.revokeAccess}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.roles, p.canManage, locale],
  );

  return (
    <div className="grid gap-5">
      <Section
        title={`${m.common.members} (${p.members.length})`}
        actions={p.canManage && <Button size="sm" onClick={() => setInviteOpen(true)}><MailPlus /> {m.org.invite}</Button>}
      >
        <DataTable data={p.members} columns={columns} getRowId={(r) => r.id} />
      </Section>
      <ConfirmAction
        open={!!statusAsk}
        onOpenChange={(o) => !o && setStatusAsk(null)}
        returnFocusTo={() => document.querySelector<HTMLElement>(`[data-member-actions="${askedFor.current}"]`)}
        title={statusAsk ? interpolate(statusAsk.status === "REVOKED" ? m.common.confirmDialog.revokeMemberTitle : m.common.confirmDialog.suspendMemberTitle, { name: locale === "ar" ? statusAsk.member.name : statusAsk.member.nameEn }) : ""}
        description={statusAsk?.status === "REVOKED" ? m.common.confirmDialog.revokeMemberBody : m.common.confirmDialog.suspendMemberBody}
        confirmLabel={statusAsk?.status === "REVOKED" ? m.org.revokeAccess : m.org.suspend}
        destructive
        onConfirm={() => (statusAsk ? setStatus.run({ membershipId: statusAsk.member.id, status: statusAsk.status }) : undefined)}
        testId="member-status-confirm"
      />

      {p.invitations.length > 0 && (
        <Section title={`${m.org.pendingInvites} (${p.invitations.length})`}>
          <ul className="divide-y">
            {p.invitations.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div>
                  <div className="ltr-nums text-sm">{i.email}</div>
                  <div className="text-xs text-muted-foreground">{roleName(i.roleId)} · {formatDate(i.expiresAt, fmt)}</div>
                </div>
                {p.canManage && (
                  <ConfirmAction
                    trigger={<Button variant="ghost" size="sm" className="text-danger">{m.org.revokeInvite}</Button>}
                    title={interpolate(m.common.confirmDialog.revokeInviteTitle, { email: i.email })}
                    description={m.common.confirmDialog.revokeInviteBody}
                    confirmLabel={m.org.revokeInvite}
                    destructive
                    onConfirm={() => revokeInv.run({ id: i.id })}
                  />
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={m.org.roles} actions={p.canManageRoles && <Button size="sm" variant="outline" onClick={() => setRoleEdit("new")}><ShieldPlus /> {m.org.newRole}</Button>}>
        <ul className="divide-y">
          {p.roles.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div>
                <div className="text-sm font-medium">{locale === "ar" ? r.nameAr : r.nameEn}</div>
                <div className="text-xs text-muted-foreground">
                  {r.isSystem ? m.org.systemRole : m.org.customRole} · {r.permissions.length} {m.org.permissions}
                </div>
              </div>
              {p.canManageRoles && r.baseRole !== "OWNER" && <Button variant="ghost" size="sm" onClick={() => setRoleEdit(r)}>{m.common.edit}</Button>}
            </li>
          ))}
        </ul>
      </Section>

      <InviteDialog {...p} open={inviteOpen} onOpenChange={setInviteOpen} />
      {roleEdit && <RoleDialog orgSlug={p.orgSlug} role={roleEdit === "new" ? null : roleEdit} catalog={p.permissionCatalog} onClose={() => setRoleEdit(null)} />}
    </div>
  );
}

function InviteDialog({ orgSlug, roles, clients, vendors, projects, open, onOpenChange }: Props & { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { m, locale } = useI18n();
  const [roleId, setRoleId] = useState(roles.find((r) => r.key === "project_manager")?.id ?? roles[0]?.id);
  const [link, setLink] = useState<string | null>(null);
  const { run, pending, errorFor } = useAction(inviteMemberAction, { orgSlug, success: m.org.inviteSent, onSuccess: (d) => setLink(`${window.location.origin}${d.link}`) });
  const base = roles.find((r) => r.id === roleId)?.baseRole;
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setLink(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{m.org.invite}</DialogTitle></DialogHeader>
        {link ? (
          <div className="grid gap-3">
            <Field label={m.org.inviteLink} hint={m.org.inviteLinkHint}>
              <div className="flex gap-2">
                <Input readOnly value={link} dir="ltr" className="text-xs" data-testid="invite-link" />
                <Button type="button" variant="outline" size="icon" onClick={() => { navigator.clipboard?.writeText(link); toast.success(m.common.copied); }} aria-label={m.common.copy}><Copy /></Button>
              </div>
            </Field>
            <DialogFooter><Button onClick={() => setLink(null)}>{m.org.invite}</Button></DialogFooter>
          </div>
        ) : (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(formObject(e.currentTarget) as never); }}>
            <Field label={m.common.email} error={errorFor("email")} required><Input name="email" type="email" required dir="ltr" /></Field>
            <Field label={m.common.name}><Input name="name" /></Field>
            <Field label={m.common.role} required>
              <NativeSelect name="roleId" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                {roles.filter((r) => r.baseRole !== "OWNER").map((r) => <option key={r.id} value={r.id}>{locale === "ar" ? r.nameAr : r.nameEn}</option>)}
              </NativeSelect>
            </Field>
            {(base === "CLIENT" || base === "CLIENT_APPROVER") && (
              <Field label={m.org.linkedClient} error={errorFor("clientId")} required>
                <NativeSelect name="clientId" required><option value="">—</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect>
              </Field>
            )}
            {base === "VENDOR" && (
              <Field label={m.org.linkedVendor} error={errorFor("vendorId")} required>
                <NativeSelect name="vendorId" required><option value="">—</option>{vendors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect>
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label={m.nav.projects}>
                <NativeSelect name="projectId"><option value="">{m.common.none}</option>{projects.map((pr) => <option key={pr.id} value={pr.id}>{pr.code} · {pr.name}</option>)}</NativeSelect>
              </Field>
              <Field label={m.common.role}>
                <NativeSelect name="projectRole" defaultValue={base === "FIELD_AGENT" ? "FIELD_AGENT" : base === "CLIENT_APPROVER" ? "CLIENT_APPROVER" : base === "CLIENT" ? "CLIENT_VIEWER" : base === "FREELANCER" ? "FREELANCER" : base === "VENDOR" ? "VENDOR" : "MEMBER"}>
                  {Object.entries(m.enums.projectRole).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </NativeSelect>
              </Field>
            </div>
            <DialogFooter><Button type="submit" disabled={pending}>{m.org.invite}</Button></DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RoleDialog({ orgSlug, role, catalog, onClose }: { orgSlug: string; role: Role | null; catalog: string[]; onClose: () => void }) {
  const { m } = useI18n();
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const { run, pending } = useAction(saveRoleAction, { orgSlug, onSuccess: onClose });
  const groups = catalog.reduce<Record<string, string[]>>((acc, k) => ((acc[k.split(".")[0]] ??= []).push(k), acc), {});
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{role ? m.common.edit : m.org.newRole}</DialogTitle></DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const o = formObject(e.currentTarget);
            run({ id: role?.id, nameAr: String(o.nameAr), nameEn: String(o.nameEn), baseRole: (role?.baseRole ?? o.baseRole) as never, permissions: [...perms] });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label={m.common.nameAr}><Input name="nameAr" defaultValue={role?.nameAr} required /></Field>
            <Field label={m.common.nameEn}><Input name="nameEn" defaultValue={role?.nameEn} required dir="ltr" /></Field>
          </div>
          {!role && (
            <Field label={m.org.baseRole}>
              <NativeSelect name="baseRole" defaultValue="EMPLOYEE">
                {Object.entries(m.enums.orgRole).filter(([k]) => k !== "OWNER").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </NativeSelect>
            </Field>
          )}
          <div className="max-h-[50vh] overflow-y-auto rounded-md border p-3">
            {Object.entries(groups).map(([g, keys]) => (
              <div key={g} className="mb-3">
                <div className="mb-1 text-xs font-medium text-muted-foreground uppercase">{g}</div>
                <div className="grid gap-1 sm:grid-cols-2">
                  {keys.map((k) => (
                    <label key={k} className="ltr-nums flex items-center gap-2 text-xs">
                      <Checkbox checked={perms.has(k)} onCheckedChange={(v) => setPerms((s) => { const n = new Set(s); if (v) n.add(k); else n.delete(k); return n; })} />
                      {k}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter><Button type="submit" disabled={pending}>{m.common.save}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
