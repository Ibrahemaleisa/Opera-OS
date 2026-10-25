/**
 * QA audit helpers (Agent 5). Thin wrappers over the real services so each adversarial
 * probe reads as a scenario. Everything runs against the operra_test database with RLS.
 */
import type { ServiceContext } from "@/server/authz/context";
import { withTenant } from "@/server/db/tenant";
import { createProject } from "@/server/modules/projects/service";
import { createTask } from "@/server/modules/tasks/service";
import { addMember, createAgency, ctxFor } from "../../helpers";

// The audit creates many agencies per file; the registration limiter (10/h per IP, in-memory
// in tests) would otherwise trip. Non-production only — see src/server/auth/rate-limit.ts.
process.env.RATE_LIMIT_MULTIPLIER = "100";

export type Agency = Awaited<ReturnType<typeof createAgency>>;
export type Member = Awaited<ReturnType<typeof addMember>>;

export const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

export async function templateId(a: Agency, key: string) {
  return withTenant({ orgId: a.orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key } } })).id);
}

export async function blankProject(ctx: ServiceContext, name = "QA project", extra: { clientId?: string | null; templateIds?: string[]; eventStartAt?: Date } = {}) {
  const { project } = await createProject(ctx, {
    name, type: "CUSTOM", priority: "MEDIUM", currency: "SAR", clientPortal: true, venueIds: [], templateIds: extra.templateIds ?? [],
    clientId: extra.clientId ?? null, eventStartAt: extra.eventStartAt,
  });
  return project;
}

export function task(ctx: ServiceContext, projectId: string, title: string, extra: Partial<Parameters<typeof createTask>[1]> = {}) {
  return createTask(ctx, { projectId, title, priority: "MEDIUM", requiresApproval: false, clientVisible: false, tags: [], ...extra });
}

export async function membershipId(orgId: string, userId: string) {
  return withTenant({ orgId }, async (tx) => (await tx.membership.findFirstOrThrow({ where: { userId } })).id);
}

export async function createClientCompany(a: Agency, name: string) {
  return withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.client.create({ data: { organizationId: a.orgId, name } }));
}

/** A client-approver user linked to a client company (membership.clientId set). */
export async function clientUser(a: Agency, clientId: string, name = "Client approver"): Promise<Member> {
  const m = await addMember(a.ctx, "client_approver", name);
  await withTenant({ orgId: a.orgId, userId: a.userId }, (tx) => tx.membership.updateMany({ where: { userId: m.userId }, data: { clientId } }));
  return { ...m, ctx: await ctxFor(m.userId, a.slug) };
}

export async function recipients(a: Agency, projectId: string, n: number, prefix = "ضيف") {
  return withTenant({ orgId: a.orgId, userId: a.userId }, async (tx) => {
    const out = [];
    for (let i = 1; i <= n; i++) {
      out.push(await tx.recipient.create({
        data: { organizationId: a.orgId, projectId, code: `R-${String(i).padStart(5, "0")}`, nameAr: `${prefix} ${i}`, mobile: `+9665551${String(i).padStart(5, "0")}`, address: `حي ${i}، الرياض`, city: "الرياض", createdById: a.userId },
      }));
    }
    return out;
  });
}
