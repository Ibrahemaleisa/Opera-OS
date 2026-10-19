import type { Prisma } from "@/generated/prisma/client";
import type { Tx } from "@/server/db/tenant";
import { SYSTEM_ROLES } from "@/server/authz/roles";
import { DEFAULT_RULES } from "@/server/modules/automation/rules";
import { STARTER_TEMPLATES } from "@/server/modules/templates/starters";

/** Seeds a new tenant: system roles, default automation rules, starter templates (v1). */
export async function bootstrapOrganization(tx: Tx, orgId: string, actorId: string | null) {
  const roles = new Map<string, string>();
  for (const r of SYSTEM_ROLES) {
    const role = await tx.role.upsert({
      where: { organizationId_key: { organizationId: orgId, key: r.key } },
      create: { organizationId: orgId, key: r.key, nameAr: r.nameAr, nameEn: r.nameEn, baseRole: r.baseRole, isSystem: true, permissions: r.permissions },
      update: { permissions: r.permissions, nameAr: r.nameAr, nameEn: r.nameEn },
    });
    roles.set(r.key, role.id);
  }
  for (const rule of DEFAULT_RULES) {
    await tx.automationRule.upsert({
      where: { organizationId_key: { organizationId: orgId, key: rule.key } },
      create: { organizationId: orgId, key: rule.key, name: rule.name, nameEn: rule.nameEn, trigger: rule.trigger, conditions: (rule.conditions ?? {}) as Prisma.InputJsonValue, actions: rule.actions as Prisma.InputJsonValue, isSystem: true },
      update: {},
    });
  }
  for (const s of STARTER_TEMPLATES) {
    const existing = await tx.template.findUnique({ where: { organizationId_key: { organizationId: orgId, key: s.key } } });
    if (existing) continue;
    const tpl = await tx.template.create({
      data: { organizationId: orgId, key: s.key, nameAr: s.nameAr, nameEn: s.nameEn, descriptionAr: s.descriptionAr, descriptionEn: s.descriptionEn, category: s.category, icon: s.icon, isSystem: true, latestVersion: 1, createdById: actorId },
    });
    await tx.templateVersion.create({
      data: { organizationId: orgId, templateId: tpl.id, version: 1, definition: s.definition as unknown as Prisma.InputJsonValue, changelog: "Initial starter template", createdById: actorId },
    });
  }
  for (const channel of ["EMAIL", "SMS", "WHATSAPP"] as const) {
    await tx.providerConfig.upsert({
      where: { organizationId_channel: { organizationId: orgId, channel } },
      create: { organizationId: orgId, channel, provider: "simulation", mode: "SIMULATION" },
      update: {},
    });
  }
  return roles;
}
