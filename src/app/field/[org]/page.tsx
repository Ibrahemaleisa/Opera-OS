import { requirePageContext } from "@/server/request";
import { FieldApp } from "./field-app";
import { guardPage } from "@/server/page-guard";

/** Shell only — no recipient data is server-rendered, so the cached shell never holds PII. */
async function FieldPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  return <FieldApp orgSlug={org} orgName={ctx.orgName} agentName={ctx.userName} />;
}

export default guardPage(FieldPage);
