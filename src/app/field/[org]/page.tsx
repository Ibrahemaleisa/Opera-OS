import { requirePageContext } from "@/server/request";
import { FieldApp } from "./field-app";

/** Shell only — no recipient data is server-rendered, so the cached shell never holds PII. */
export default async function FieldPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  return <FieldApp orgSlug={org} orgName={ctx.orgName} agentName={ctx.userName} />;
}
