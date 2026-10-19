import { PageHeader } from "@/components/app/page";
import { getI18n } from "@/lib/i18n/server";
import { assertCan } from "@/server/authz/policy";
import { listCustomFields } from "@/server/modules/org/service";
import { requirePageContext } from "@/server/request";
import { FieldsClient } from "./fields-client";

export default async function FieldsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  assertCan(ctx, "org.customFields.manage");
  const { m } = await getI18n();
  const fields = await listCustomFields(ctx);
  return (
    <>
      <PageHeader title={m.org.customFields} description={m.org.customFieldsDesc} />
      <FieldsClient orgSlug={org} fields={fields.map((f) => ({ id: f.id, entityType: f.entityType, key: f.key, labelAr: f.labelAr, labelEn: f.labelEn, fieldType: f.fieldType, options: f.options as string[], required: f.required, projectId: f.projectId }))} />
    </>
  );
}
