import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { createProject } from "@/server/modules/projects/service";
import { addAudience, checkIn, getDigitalCampaign, getRsvpPage, launchCampaign, optOut, requestCampaignApproval, saveDigitalCampaign, submitRsvp } from "@/server/modules/digital/service";
import { applyProviderEvent } from "@/server/modules/digital/sender";
import { signSimulationWebhook, verifyAndParseWebhook } from "@/server/modules/digital/providers";
import { decideApproval } from "@/server/modules/approvals/service";
import { addMember, createAgency } from "../helpers";
import { adminDb } from "@/server/db/admin";

describe("digital invitations", () => {
  it("approval-gated simulated campaign → webhook receipts → RSVP → QR check-in → opt-out", async () => {
    process.env.WEBHOOK_SECRET_SIMULATION = "test-webhook-secret";
    const a = await createAgency("Digital");
    const tpl = (key: string) => withTenant({ orgId: a.orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key } } })).id);
    const { project } = await createProject(a.ctx, { name: "Gala", type: "EVENT", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [await tpl("vip-digital-campaign"), await tpl("corporate-event")], eventStartAt: new Date("2026-12-20T19:00:00+03:00") });
    const recipients = await withTenant({ orgId: a.orgId }, async (tx) => {
      const rows = [
        { code: "R-00001", nameAr: "سعادة الضيف الأول", mobile: "+966555000001" },
        { code: "R-00002", nameAr: "سعادة الضيف الثاني", mobile: "+966555000000" }, // simulation fails once
        { code: "R-00003", nameAr: "سعادة الضيف الثالث", mobile: null },
      ];
      return Promise.all(rows.map((r) => tx.recipient.create({ data: { ...r, organizationId: a.orgId, projectId: project.id, createdById: a.userId } })));
    });
    const draft = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: project.id, type: "DIGITAL" } }));
    const c = await saveDigitalCampaign(a.ctx, { id: draft.id, projectId: project.id, name: "دعوة الحفل", channel: "SMS", bodyTemplate: "{{honorific}} {{name}}، يسرنا دعوتكم إلى {{event_name}}. للتأكيد: {{rsvp_link}}", rsvpEnabled: true, qrEnabled: true });
    const aud = await addAudience(a.ctx, { campaignId: c.id, recipientIds: recipients.map((r) => r.id) });
    expect(aud).toMatchObject({ added: 3, missing: 1 });

    // cannot launch without approval
    await expect(launchCampaign(a.ctx, c.id)).rejects.toThrow("errors.campaignNotApproved");
    // the approver must exist when approval is requested: a request nobody else can decide is refused
    await expect(requestCampaignApproval(a.ctx, c.id)).rejects.toThrow("errors.noEligibleApprover");
    const director = await addMember(a.ctx, "ops_director", "Director");
    const approval = await requestCampaignApproval(a.ctx, c.id);
    // requester cannot approve their own bulk campaign (four-eyes)
    await expect(decideApproval(a.ctx, { approvalId: approval.id, decision: "APPROVED" })).rejects.toThrow("errors.forbidden");
    await decideApproval(director.ctx, { approvalId: approval.id, decision: "APPROVED", comment: "ok" });

    const launched = await launchCampaign(a.ctx, c.id);
    expect(launched.mode).toBe("inline");
    const d = await getDigitalCampaign(a.ctx, c.id);
    expect(d.providerMode).toBe("SIMULATION");
    expect(d.counts.SENT).toBe(2);
    expect(d.counts.SUPPRESSED).toBe(1);
    expect(d.simulatedMessages).toBe(2);
    const jobs = await adminDb().messageJob.findMany({ where: { organizationId: a.orgId }, orderBy: { to: "asc" } });
    expect(jobs.find((j) => j.to === "+966555000000")?.attempts).toBe(2); // one transient failure, retried
    expect(jobs.every((j) => j.simulated && j.body.includes("/rsvp/"))).toBe(true);

    // signed delivery receipt; tampered signature rejected; duplicate ignored
    const body = JSON.stringify({ id: "evt-1", messageId: jobs[0].providerMessageId, status: "DELIVERED" });
    expect(verifyAndParseWebhook("simulation", body, new Headers({ "x-operra-signature": "bad" }))).toBeNull();
    const events = verifyAndParseWebhook("simulation", body, new Headers({ "x-operra-signature": signSimulationWebhook(body) }))!;
    expect(await applyProviderEvent("simulation", events[0], JSON.parse(body))).toEqual({ applied: "DELIVERED" });
    expect(await applyProviderEvent("simulation", events[0], JSON.parse(body))).toEqual({ duplicate: true });

    // RSVP with the token embedded in the message
    const token = /\/rsvp\/([A-Za-z0-9_-]+)/.exec(jobs[1].body)![1];
    const page = await getRsvpPage(token);
    expect(page?.recipient?.nameAr).toContain("الضيف");
    expect(page).not.toHaveProperty("recipient.mobile");
    await submitRsvp({ token, response: "ATTENDING", guestsCount: 2 }, "127.0.0.1");
    const after = await getRsvpPage(token);
    expect(after?.rsvpStatus).toBe("ATTENDING");
    expect(after?.qrCode).toMatch(/^QR-/);
    const ci = await checkIn(a.ctx, { campaignId: c.id, code: after!.qrCode! });
    expect(ci.already).toBe(false);
    expect((await checkIn(a.ctx, { campaignId: c.id, code: after!.qrCode! })).already).toBe(true);

    // opt-out → suppression list
    const token2 = /\/rsvp\/([A-Za-z0-9_-]+)/.exec(jobs[0].body)![1];
    await optOut(token2, "127.0.0.1");
    const sup = await withTenant({ orgId: a.orgId }, (tx) => tx.suppressionEntry.count({ where: { channel: "SMS" } }));
    expect(sup).toBe(1);
    expect(await getRsvpPage("not-a-real-token-xxxxxxxx")).toBeNull();
  });
});
