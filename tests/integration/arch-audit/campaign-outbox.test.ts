/**
 * ARCH-AUDIT probes (Agent 2). Assert intended behaviour; failures document live defects.
 */
import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { adminDb } from "@/server/db/admin";
import { createProject, upsertProjectMember } from "@/server/modules/projects/service";
import { createTask } from "@/server/modules/tasks/service";
import { decideApproval } from "@/server/modules/approvals/service";
import { addAudience, launchCampaign, requestCampaignApproval, saveDigitalCampaign } from "@/server/modules/digital/service";
import { processOutbox } from "@/server/modules/automation/engine";
import { schedulerTick } from "@/server/modules/automation/scheduler";
import { addMember, createAgency } from "../../helpers";

/** The campaign version a user would have loaded: launch, approval requests and edits carry it (BUSINESS_RULES §6). */
const cver = (id: string) => adminDb().invitationCampaign.findUniqueOrThrow({ where: { id } }).then((x) => x.version);

async function digitalSetup(n: number) {
  const a = await createAgency("ArchDigital");
  const tpl = await withTenant({ orgId: a.orgId }, (tx) => tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key: "vip-digital-campaign" } } }));
  const { project } = await createProject(a.ctx, { name: "Gala", type: "EVENT", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [tpl.id] });
  const recipients = await withTenant({ orgId: a.orgId }, async (tx) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await tx.recipient.create({ data: { organizationId: a.orgId, projectId: project.id, code: `R-${String(i + 1).padStart(5, "0")}`, nameAr: `ضيف ${i + 1}`, mobile: `+9665550010${String(i).padStart(2, "0")}`, createdById: a.userId } }));
    return out;
  });
  const draft = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: project.id, type: "DIGITAL" } }));
  const director = await addMember(a.ctx, "ops_director", "Director");
  return { a, project, recipients, draftId: draft.id, director };
}

const jobsFor = (orgId: string) => adminDb().messageJob.findMany({ where: { organizationId: orgId, invitationId: { not: null } } });

describe("arch-audit: campaign approval binding & scheduling", () => {
  it("recipients added after approval are not sent without a fresh approval", async () => {
    const { a, project, recipients, draftId, director } = await digitalSetup(3);
    const c = await saveDigitalCampaign(a.ctx, { id: draftId, version: await cver(draftId), projectId: project.id, name: "Invite", channel: "SMS", bodyTemplate: "مرحبا {{name}} {{rsvp_link}}", rsvpEnabled: true, qrEnabled: false });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [recipients[0].id] });
    const ap = await requestCampaignApproval(a.ctx, c.id, await cver(c.id)); // approval title says "(1)"
    await decideApproval(director.ctx, { approvalId: ap.id, decision: "APPROVED" });
    // audience grows after the four-eyes decision
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [recipients[1].id, recipients[2].id] }).catch(() => null);
    await launchCampaign(a.ctx, c.id, await cver(c.id)).catch(() => null);
    // SAFE: at most the 1 approved recipient was messaged
    expect((await jobsFor(a.orgId)).length).toBeLessThanOrEqual(1);
  });

  it("content edited while the approval is pending invalidates that approval", async () => {
    const { a, project, recipients, draftId, director } = await digitalSetup(1);
    const c = await saveDigitalCampaign(a.ctx, { id: draftId, version: await cver(draftId), projectId: project.id, name: "Invite", channel: "SMS", bodyTemplate: "Original approved text {{rsvp_link}}", rsvpEnabled: true, qrEnabled: false });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [recipients[0].id] });
    const ap = await requestCampaignApproval(a.ctx, c.id, await cver(c.id));
    await saveDigitalCampaign(a.ctx, { id: c.id, version: await cver(c.id), projectId: project.id, name: "Invite", channel: "SMS", bodyTemplate: "SWAPPED text after review {{rsvp_link}}", rsvpEnabled: true, qrEnabled: false });
    await decideApproval(director.ctx, { approvalId: ap.id, decision: "APPROVED" }).catch(() => null);
    await launchCampaign(a.ctx, c.id, await cver(c.id)).catch(() => null);
    const jobs = await jobsFor(a.orgId);
    // SAFE: nothing containing unreviewed text was sent
    expect(jobs.some((j) => j.body.includes("SWAPPED"))).toBe(false);
  });

  it("a scheduled campaign is not sent before its scheduledAt (JOBS_MODE=inline, the Vercel mode)", async () => {
    expect(process.env.JOBS_MODE).toBe("inline");
    const { a, project, recipients, draftId, director } = await digitalSetup(1);
    const c = await saveDigitalCampaign(a.ctx, { id: draftId, version: await cver(draftId), projectId: project.id, name: "Invite", channel: "SMS", bodyTemplate: "مرحبا {{name}} {{rsvp_link}}", rsvpEnabled: true, qrEnabled: false, scheduledAt: new Date(Date.now() + 2 * 86400_000) });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [recipients[0].id] });
    const ap = await requestCampaignApproval(a.ctx, c.id, await cver(c.id));
    await decideApproval(director.ctx, { approvalId: ap.id, decision: "APPROVED" });
    const r = await launchCampaign(a.ctx, c.id, await cver(c.id));
    expect(r.status).toBe("SCHEDULED");
    const sent = (await jobsFor(a.orgId)).filter((j) => ["SENT", "DELIVERED", "READ", "SENDING"].includes(j.status));
    // SAFE: nothing goes out two days early
    expect(sent.length).toBe(0);
  });
});

describe("arch-audit: outbox / scheduler idempotency under concurrency", () => {
  it("two concurrent outbox drains create each notification exactly once", async () => {
    const a = await createAgency("ArchOutbox");
    const { project } = await createProject(a.ctx, { name: "P", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
    const emp = await addMember(a.ctx, "employee", "Employee");
    await upsertProjectMember(a.ctx, { projectId: project.id, userId: emp.userId, role: "MEMBER", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    const N = 40;
    for (let i = 0; i < N; i++) await createTask(a.ctx, { projectId: project.id, title: `Task ${i}`, priority: "LOW", requiresApproval: false, clientVisible: false, tags: [], ownerId: emp.userId });
    // the service layer leaves events pending (orgAction would kick inline); drain them concurrently,
    // which is what overlapping requests in JOBS_MODE=inline, or the worker sweep + an outbox job, do.
    await Promise.all([processOutbox(a.orgId), processOutbox(a.orgId), processOutbox(a.orgId)]);
    for (let i = 0; i < 3; i++) await processOutbox(a.orgId); // retry anything that collided
    const n = await withTenant({ orgId: a.orgId }, (tx) => tx.notification.count({ where: { userId: emp.userId, type: "task.assigned" } }));
    expect(n).toBe(N);
  });

  it("two concurrent scheduler ticks emit each overdue event once", async () => {
    const a = await createAgency("ArchScheduler");
    const { project } = await createProject(a.ctx, { name: "P", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
    await createTask(a.ctx, { projectId: project.id, title: "Late", priority: "LOW", requiresApproval: false, clientVisible: false, tags: [], ownerId: a.userId, dueAt: new Date(Date.now() - 3600_000) });
    const now = new Date();
    await Promise.all([schedulerTick(now), schedulerTick(now)]);
    const n = await withTenant({ orgId: a.orgId }, (tx) => tx.outboxEvent.count({ where: { type: "task.overdue" } }));
    expect(n).toBe(1);
  });
});
