/**
 * QA audit (Agent 5) — outbound messaging controls. Bulk VIP messaging is irreversible, so
 * the four-eyes approval must cover exactly what is sent, when it is sent.
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/auth/crypto";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { decideApproval } from "@/server/modules/approvals/service";
import { addAudience, getRsvpPage, launchCampaign, requestCampaignApproval, saveDigitalCampaign, submitRsvp } from "@/server/modules/digital/service";
import { setProjectStatus } from "@/server/modules/projects/service";
import { addMember, createAgency } from "../../helpers";
import { blankProject, recipients, templateId } from "./qa-helpers";

/** The campaign version a user would have loaded: launch, approval requests and edits carry it (BUSINESS_RULES §6). */
const cver = (id: string) => adminDb().invitationCampaign.findUniqueOrThrow({ where: { id } }).then((x) => x.version);

const DAY = 86_400_000;
const BODY = "{{honorific}} {{name}}، يسرنا دعوتكم. للتأكيد: {{rsvp_link}}";

async function setup(name: string, opts: { scheduledAt?: Date } = {}) {
  const a = await createAgency(name);
  const p = await blankProject(a.ctx, name, { templateIds: [await templateId(a, "vip-digital-campaign")], eventStartAt: new Date(Date.now() + 30 * DAY) });
  const rs = await recipients(a, p.id, 3);
  const draft = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "DIGITAL" } }));
  const c = await saveDigitalCampaign(a.ctx, { id: draft.id, version: await cver(draft.id), projectId: p.id, name: "VIP gala invitation", channel: "SMS", bodyTemplate: BODY, rsvpEnabled: true, qrEnabled: true, scheduledAt: opts.scheduledAt ?? null });
  const director = await addMember(a.ctx, "ops_director", "Approving director");
  const sent = () => adminDb().messageJob.count({ where: { invitation: { campaignId: c.id } } });
  return { a, p, rs, c, director, sent };
}

describe("QA: digital campaign approvals cover what is actually sent", () => {
  it("adding recipients after approval requires a new approval before launch", async () => {
    const { a, p, rs, c, director, sent } = await setup("QA AudienceAfterApproval");
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [rs[0].id] });
    const appr = await requestCampaignApproval(a.ctx, c.id, await cver(c.id)); // director approves "VIP gala invitation (1)"
    await decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: "1 guest ok" });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [rs[1].id, rs[2].id] }).catch(() => undefined);
    await launchCampaign(a.ctx, c.id, await cver(c.id)).catch(() => undefined);
    void p;
    // EXPECTED: no more messages than the approver approved
    expect(await sent()).toBeLessThanOrEqual(1);
  });

  it("editing the message while approval is pending invalidates the pending approval", async () => {
    const { a, p, rs, c, director } = await setup("QA EditWhilePending");
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: rs.map((r) => r.id) });
    const appr = await requestCampaignApproval(a.ctx, c.id, await cver(c.id));
    await saveDigitalCampaign(a.ctx, { id: c.id, version: await cver(c.id), projectId: p.id, name: "VIP gala invitation", channel: "SMS", bodyTemplate: "URGENT: event moved, call +966500000000 now {{rsvp_link}}", rsvpEnabled: true, qrEnabled: true }).catch(() => undefined);
    // EXPECTED: the approver can no longer approve a request whose content changed underneath it
    await expect(decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null })).rejects.toThrow();
  });

  it("a campaign scheduled for next week is not sent at launch time (JOBS_MODE=inline, the Vercel mode)", async () => {
    const when = new Date(Date.now() + 7 * DAY);
    const { a, rs, c, director, sent } = await setup("QA ScheduledInline", { scheduledAt: when });
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: rs.map((r) => r.id) });
    const appr = await requestCampaignApproval(a.ctx, c.id, await cver(c.id));
    await decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
    const r = await launchCampaign(a.ctx, c.id, await cver(c.id));
    expect(r.status).toBe("SCHEDULED"); // what the UI tells the user …
    const after = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findUniqueOrThrow({ where: { id: c.id } }));
    expect.soft(after.status, "campaign still scheduled").toBe("SCHEDULED");
    expect.soft(await sent(), "… and what actually happened: messages already sent").toBe(0);
  });

  it("a cancelled project cannot launch its approved campaign", async () => {
    const { a, p, rs, c, director, sent } = await setup("QA CancelledProjectCampaign");
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: rs.map((r) => r.id) });
    const appr = await requestCampaignApproval(a.ctx, c.id, await cver(c.id));
    await decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
    // M2 (§1.2, §6): cancelling carries the loaded version and a reason
    await setProjectStatus(a.ctx, p.id, "CANCELLED", { version: (await withTenant({ orgId: a.orgId }, (tx) => tx.project.findUniqueOrThrow({ where: { id: p.id } }))).version, reason: "QA: project cancelled by the client" });
    await launchCampaign(a.ctx, c.id, await cver(c.id)).catch(() => undefined);
    expect(await sent()).toBe(0);
  });

  it("concurrent double-click on Launch sends each guest exactly once (control)", async () => {
    const { a, rs, c, director, sent } = await setup("QA DoubleLaunch");
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: rs.map((r) => r.id) });
    const appr = await requestCampaignApproval(a.ctx, c.id, await cver(c.id));
    await decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
    const loaded = await cver(c.id); // both clicks come from the same loaded page
    const res = await Promise.allSettled([launchCampaign(a.ctx, c.id, loaded), launchCampaign(a.ctx, c.id, loaded)]);
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await sent()).toBe(3);
  });

  it("an expired RSVP link no longer shows the guest's name or accepts a response", async () => {
    const { a, rs, c, director } = await setup("QA RsvpExpiry");
    await addAudience(a.ctx, { campaignId: c.id, recipientIds: [rs[0].id] });
    const appr = await requestCampaignApproval(a.ctx, c.id, await cver(c.id));
    await decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
    await launchCampaign(a.ctx, c.id, await cver(c.id));
    const job = await adminDb().messageJob.findFirstOrThrow({ where: { invitation: { campaignId: c.id } } });
    const token = /\/rsvp\/([A-Za-z0-9_-]+)/.exec(job.body)![1];
    await adminDb().publicToken.update({ where: { id: sha256Hex(token) }, data: { expiresAt: new Date(Date.now() - DAY) } });
    expect.soft(await getRsvpPage(token), "page for an expired token").toBeNull();
    await expect.soft(submitRsvp({ token, response: "DECLINED", guestsCount: 1 }, "127.0.0.9")).rejects.toThrow();
    void a;
  });
});
