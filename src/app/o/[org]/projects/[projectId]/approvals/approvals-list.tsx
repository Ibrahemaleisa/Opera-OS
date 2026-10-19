"use client";

import { ApprovalsBox } from "@/app/o/[org]/tasks/[taskId]/task-detail";

export function ApprovalsList({ orgSlug, approvals, users, canDecide }: { orgSlug: string; approvals: Parameters<typeof ApprovalsBox>[0]["approvals"]; users: Record<string, string>; canDecide: boolean }) {
  return <ApprovalsBox orgSlug={orgSlug} approvals={approvals} canDecide={canDecide} nameOf={(id) => (id ? users[id] ?? "—" : "—")} />;
}
