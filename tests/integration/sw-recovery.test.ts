/**
 * BUSINESS_RULES §7 (stalled work recovery): import leases (§7.1), dispatch leases, unknown
 * outcomes and late scheduled sends (§7.2), and System health (§7.4). SW-1 … SW-9.
 */
import { describe, expect, it } from "vitest";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { createProject } from "@/server/modules/projects/service";
import { decideApproval } from "@/server/modules/approvals/service";
import { commitImport, configureAndValidate, createImport, importStatus, IMPORT_LEASE_MS, resumeImport, rollbackImport, runCommit } from "@/server/modules/delivery/imports/service";
import { addAudience, getDigitalCampaign, launchCampaign, requestCampaignApproval, saveDigitalCampaign } from "@/server/modules/digital/service";
import { dispatchCampaign, dispatchDueCampaigns, sendMessageJob } from "@/server/modules/digital/sender";
import { recoverStalledWork, systemHealth } from "@/server/modules/recovery/service";
import { tickOrganization } from "@/server/modules/automation/scheduler";
import { addMember, createAgency } from "../helpers";

const MIN = 60_000;
const DAY = 86_400_000;
const BODY = "{{honorific}} {{name}}، يسرنا دعوتكم. للتأكيد: {{rsvp_link}}";
const db = () => adminDb();

type Agency = Awaited<ReturnType<typeof createAgency>>;

/** One agency per area (registration is rate-limited per process); every test uses its own project. */
const agencies = new Map<string, Promise<Agency & { director: Awaited<ReturnType<typeof addMember>> }>>();
function agency(key: string) {
  if (!agencies.has(key)) agencies.set(key, createAgency(`SW ${key}`).then(async (a) => ({ ...a, director: await addMember(a.ctx, "ops_director", "Approving director") })));
  return agencies.get(key)!;
}

async function project(a: Agency, templates: string[], type = "EVENT") {
  const tpl = (key: string) => withTenant({ orgId: a.orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: a.orgId, key } } })).id);
  const { project } = await createProject(a.ctx, { name: "Recovery", type: type as never, priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: await Promise.all(templates.map(tpl)), eventStartAt: new Date(Date.now() + 30 * DAY) });
  return project;
}

function csv(n: number) {
  const lines = ["الاسم,الجوال,العنوان,المدينة"];
  for (let i = 0; i < n; i++) lines.push(`ضيف ${i},055${String(2_000_000 + i).slice(-7)},حي ${i % 40},الرياض`);
  return Buffer.from(lines.join("\n"), "utf8");
}

async function validatedImport(a: Agency, projectId: string, rows: number) {
  const batch = await createImport(a.ctx, { projectId, campaignId: null, fileName: "list.csv", declaredType: "text/csv", body: csv(rows) });
  await configureAndValidate(a.ctx, { batchId: batch.id, sheetName: batch.sheetName!, headerRow: batch.headerRow, mapping: { nameAr: "الاسم", mobile: "الجوال", address: "العنوان", city: "المدينة" }, options: { duplicateScope: "PROJECT", matchOn: ["mobile"], requireMobile: true, requireLocation: true } });
  return batch.id;
}

/** An approved digital campaign with `n` SMS recipients (never the simulation's failing number). */
async function approvedCampaign(n: number, scheduledAt: Date | null = null) {
  const a = await agency("sends");
  const director = a.director;
  const p = await project(a, ["vip-digital-campaign", "corporate-event"]);
  await withTenant({ orgId: a.orgId }, (tx) =>
    tx.recipient.createMany({ data: Array.from({ length: n }, (_, i) => ({ organizationId: a.orgId, projectId: p.id, createdById: a.userId, code: `R-${String(i + 1).padStart(5, "0")}`, nameAr: `ضيف ${i + 1}`, mobile: `+9665553${String(i + 1).padStart(5, "0")}` })) }),
  );
  const ids = (await db().recipient.findMany({ where: { projectId: p.id }, select: { id: true } })).map((r) => r.id);
  const draft = await db().invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "DIGITAL" } });
  const c = await saveDigitalCampaign(a.ctx, { id: draft.id, version: draft.version, projectId: p.id, name: "Gala", channel: "SMS", bodyTemplate: BODY, rsvpEnabled: true, qrEnabled: false, scheduledAt });
  await addAudience(a.ctx, { campaignId: c.id, recipientIds: ids });
  const ver = async () => (await db().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).version;
  const appr = await requestCampaignApproval(a.ctx, c.id, await ver());
  await decideApproval(director.ctx, { approvalId: appr.id, decision: "APPROVED", comment: null });
  return { a, p, c, director, ver };
}

describe("SW · stalled imports (§7.1)", () => {
  it("SW-1 a commit that died after 600 of 1000 rows is resumed by the sweep and ends COMMITTED with 1000 rows, none duplicated", async () => {
    const a = await agency("imports");
    const p = await project(a, [], "VIP_DELIVERY");
    const batchId = await validatedImport(a, p.id, 1000);
    // the user starts the commit (what commitImport claims), and the process dies after two chunks
    await db().importBatch.update({ where: { id: batchId }, data: { status: "COMMITTING", leaseOwner: "req:dead", leaseUntil: new Date(Date.now() + IMPORT_LEASE_MS), attempts: 1, committedById: a.userId, options: { includeWarnings: true, acceptPartial: true } } });
    const partial = await runCommit(a.orgId, a.userId, batchId, "req:dead", { stopAfterChunks: 2 });
    expect(partial).toMatchObject({ stopped: true });
    expect(await db().importRow.count({ where: { batchId, status: "COMMITTED" } })).toBe(600);
    expect((await db().importBatch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("COMMITTING");

    // while the lease is live the sweep leaves it alone; once expired it resumes from row 601
    expect((await recoverStalledWork(a.orgId)).resumed).toBe(0);
    const later = new Date(Date.now() + IMPORT_LEASE_MS + MIN);
    expect((await recoverStalledWork(a.orgId, later)).resumed).toBeGreaterThanOrEqual(1);

    const b = await db().importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(b).toMatchObject({ status: "COMMITTED", committedRows: 1000, attempts: 2, leaseOwner: null });
    const recipients = await db().recipient.findMany({ where: { importBatchId: batchId }, select: { code: true, mobile: true, importRowId: true } });
    expect(recipients).toHaveLength(1000);
    expect(new Set(recipients.map((r) => r.mobile)).size).toBe(1000);
    expect(new Set(recipients.map((r) => r.code)).size).toBe(1000);
    expect(new Set(recipients.map((r) => r.importRowId)).size).toBe(1000);
    expect(await db().auditEvent.count({ where: { entityType: "IMPORT", entityId: batchId, action: "import.resume" } })).toBe(1);
  }, 120_000);

  it("SW-2 after three attempts a stalled validation is FAILED with import.stalled and the actor gets one notice", async () => {
    const a = await agency("imports");
    const p = await project(a, [], "VIP_DELIVERY");
    const batchId = await validatedImport(a, p.id, 5);
    // a validation whose third attempt also stopped renewing its lease
    await db().importBatch.update({ where: { id: batchId }, data: { status: "VALIDATING", leaseOwner: "resume:dead", leaseUntil: new Date(Date.now() - MIN), attempts: 3 } });
    const r = await recoverStalledWork(a.orgId);
    expect(r.failed).toBe(1);
    expect(await db().importBatch.findUniqueOrThrow({ where: { id: batchId } })).toMatchObject({ status: "FAILED", error: "import.stalled", leaseOwner: null });
    const notices = await db().notification.findMany({ where: { organizationId: a.orgId, userId: a.userId, type: "import.stalled", entityId: batchId } });
    expect(notices).toHaveLength(1);
    // a later sweep repeats nothing
    await recoverStalledWork(a.orgId, new Date(Date.now() + 10 * MIN));
    expect(await db().notification.count({ where: { organizationId: a.orgId, userId: a.userId, type: "import.stalled", entityId: batchId } })).toBe(1);
    // the import can be validated again from FAILED
    expect((await importStatus(a.ctx, batchId)).status).toBe("FAILED");
  });

  it("SW-2 a stalled commit with committed rows becomes PARTIALLY_COMMITTED (rollback stays available) and the PMs are told too", async () => {
    const a = await agency("imports");
    const pm = await addMember(a.ctx, "project_manager", "PM SW2b");
    const p = await project(a, [], "VIP_DELIVERY");
    await withTenant({ orgId: a.orgId }, (tx) => tx.projectMember.create({ data: { organizationId: a.orgId, projectId: p.id, userId: pm.userId, role: "MANAGER" } }));
    const batchId = await validatedImport(a, p.id, 400);
    await db().importBatch.update({ where: { id: batchId }, data: { status: "COMMITTING", leaseOwner: "req:dead", leaseUntil: new Date(Date.now() + IMPORT_LEASE_MS), attempts: 3, committedById: a.userId, options: { includeWarnings: true, acceptPartial: true } } });
    await runCommit(a.orgId, a.userId, batchId, "req:dead", { stopAfterChunks: 1 });
    await recoverStalledWork(a.orgId, new Date(Date.now() + IMPORT_LEASE_MS + MIN));
    const b = await db().importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(b).toMatchObject({ status: "PARTIALLY_COMMITTED", committedRows: 300, error: "import.stalled" });
    expect(await db().notification.count({ where: { organizationId: a.orgId, type: "import.stalled", entityId: batchId, userId: { in: [a.userId, pm.userId] } } })).toBe(2);
    expect(await rollbackImport(a.ctx, batchId)).toMatchObject({ recipients: 300 });
  });

  it("SW-3 Resume is offered once the lease has been expired for 120 s, works once, and a second click does nothing", async () => {
    const a = await agency("imports");
    const p = await project(a, [], "VIP_DELIVERY");
    const batchId = await validatedImport(a, p.id, 20);
    await db().importBatch.update({ where: { id: batchId }, data: { status: "VALIDATING", leaseOwner: "req:dead", leaseUntil: new Date(Date.now() - 30_000), attempts: 1 } });
    // paused, but not yet resumable by hand
    expect(await importStatus(a.ctx, batchId)).toMatchObject({ status: "VALIDATING", paused: true, resumable: false, attempts: 1, maxAttempts: 3 });
    expect(await resumeImport(a.ctx, batchId)).toEqual({ outcome: "live" });
    await db().importBatch.update({ where: { id: batchId }, data: { leaseUntil: new Date(Date.now() - IMPORT_LEASE_MS - MIN) } });
    expect(await importStatus(a.ctx, batchId)).toMatchObject({ paused: true, resumable: true });
    // a double click: exactly one resume runs
    const both = await Promise.all([resumeImport(a.ctx, batchId), resumeImport(a.ctx, batchId)]);
    expect(both.filter((r) => r.outcome === "resumed")).toHaveLength(1);
    expect(both.map((r) => r.outcome).every((o) => ["resumed", "busy", "live", "not_running"].includes(o))).toBe(true);
    const b = await db().importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(b).toMatchObject({ status: "VALIDATED", attempts: 2 });
    expect(await db().importRow.count({ where: { batchId } })).toBe(20);
    expect(await db().auditEvent.count({ where: { entityType: "IMPORT", entityId: batchId, action: "import.resume" } })).toBe(1);
    // and once finished, Resume is refused
    await expect(resumeImport(a.ctx, batchId)).rejects.toThrow("errors.importNotResumable");
  });

  it("SW-7 a 12,000-row file is refused at upload with the cap, before any row is parsed", async () => {
    const a = await agency("imports");
    const p = await project(a, [], "VIP_DELIVERY");
    await expect(createImport(a.ctx, { projectId: p.id, campaignId: null, fileName: "big.csv", declaredType: "text/csv", body: csv(12_000) })).rejects.toMatchObject({ message: "errors.tooManyRows", fieldErrors: { max: ["10000"] } });
    expect(await db().importBatch.count({ where: { projectId: p.id } })).toBe(0);
  });

  it("SW-8 rollback is refused once the batch's recipients are in a digital campaign audience", async () => {
    const a = await agency("imports");
    const p = await project(a, ["vip-digital-campaign"]);
    const batchId = await validatedImport(a, p.id, 3);
    await commitImport(a.ctx, { batchId, includeWarnings: true, acceptPartial: true });
    const ids = (await db().recipient.findMany({ where: { importBatchId: batchId }, select: { id: true } })).map((r) => r.id);
    const draft = await db().invitationCampaign.findFirstOrThrow({ where: { projectId: p.id, type: "DIGITAL" } });
    await saveDigitalCampaign(a.ctx, { id: draft.id, version: draft.version, projectId: p.id, name: "Invite", channel: "SMS", bodyTemplate: BODY, rsvpEnabled: true, qrEnabled: false });
    await addAudience(a.ctx, { campaignId: draft.id, recipientIds: [ids[0]] });
    await expect(rollbackImport(a.ctx, batchId)).rejects.toThrow("errors.rollbackUnsafe");
    expect(await db().recipient.count({ where: { importBatchId: batchId } })).toBe(3);
  });
});

describe("SW · stalled and late sends (§7.2)", () => {
  it("SW-4 a dispatch that died after 120 of 300 messages is resumed: exactly 300 messages, none sent twice", async () => {
    const { a, c } = await approvedCampaign(300);
    const invitations = await db().digitalInvitation.findMany({ where: { campaignId: c.id }, orderBy: { id: "asc" } });
    expect(invitations).toHaveLength(300);
    // what launch + the dead dispatch left: SENDING, attempt 1, 120 sent, 30 created but never sent
    await db().invitationCampaign.update({ where: { id: c.id }, data: { status: "SENDING", dispatchAttempts: 1, dispatchLeaseUntil: new Date(Date.now() - MIN) } });
    const sentAt = new Date(Date.now() - 5 * MIN);
    for (const [i, inv] of invitations.slice(0, 150).entries()) {
      const sent = i < 120;
      await db().messageJob.create({ data: { organizationId: a.orgId, invitationId: inv.id, channel: "SMS", provider: "simulation", simulated: true, to: inv.address, body: "x", idempotencyKey: `${c.id}:${inv.id}:initial`, status: sent ? "SENT" : "QUEUED", attempts: sent ? 1 : 0, sentAt: sent ? sentAt : null, providerMessageId: sent ? `sim-${inv.id}` : null } });
      if (sent) await db().digitalInvitation.update({ where: { id: inv.id }, data: { status: "SENT" } });
    }
    const r = await recoverStalledWork(a.orgId);
    expect(r.resumed).toBe(1);
    const jobs = await db().messageJob.findMany({ where: { invitation: { campaignId: c.id } } });
    expect(jobs).toHaveLength(300);
    expect(new Set(jobs.map((j) => j.invitationId)).size).toBe(300);
    expect(jobs.every((j) => j.status === "SENT" && j.attempts === 1)).toBe(true);
    // the 120 already sent were not touched
    expect(jobs.filter((j) => j.sentAt?.getTime() === sentAt.getTime())).toHaveLength(120);
    expect(await db().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "ACTIVE", dispatchAttempts: 2, dispatchLeaseUntil: null });
  }, 120_000);

  it("SW-4 at 5 attempts the send is reported stalled (one mandatory notice), and Resume sending / Cancel remaining stay available", async () => {
    const { a, c } = await approvedCampaign(4);
    await db().invitationCampaign.update({ where: { id: c.id }, data: { status: "SENDING", dispatchAttempts: 5, dispatchLeaseUntil: new Date(Date.now() - MIN) } });
    const r = await recoverStalledWork(a.orgId);
    expect(r.resumed).toBe(0);
    expect(await db().messageJob.count({ where: { invitation: { campaignId: c.id } } })).toBe(0);
    expect((await getDigitalCampaign(a.ctx, c.id)).send).toMatchObject({ stalled: true, attempts: 5 });
    const told = await db().notification.findMany({ where: { organizationId: a.orgId, type: "campaign.dispatch_stalled", entityId: c.id }, select: { userId: true } });
    expect(told.map((n) => n.userId)).toContain(a.director.userId); // the approver stands in for the launcher here
    await recoverStalledWork(a.orgId, new Date(Date.now() + 5 * MIN));
    expect(await db().notification.count({ where: { organizationId: a.orgId, type: "campaign.dispatch_stalled", entityId: c.id } })).toBe(told.length);
    // the human decision: resume sending sends everything once
    const { resumeCampaignSend } = await import("@/server/modules/digital/service");
    expect(await resumeCampaignSend(a.ctx, c.id)).toEqual({ resumed: true });
    expect(await db().messageJob.count({ where: { invitation: { campaignId: c.id }, status: "SENT" } })).toBe(4);
    expect((await db().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("ACTIVE");
  });

  it("SW-4 Cancel remaining sends cancels what is queued and keeps what was sent", async () => {
    const { a, c } = await approvedCampaign(3);
    const [first, ...rest] = await db().digitalInvitation.findMany({ where: { campaignId: c.id }, orderBy: { id: "asc" } });
    await db().invitationCampaign.update({ where: { id: c.id }, data: { status: "SENDING", dispatchAttempts: 5, dispatchLeaseUntil: new Date(Date.now() - MIN) } });
    await db().messageJob.create({ data: { organizationId: a.orgId, invitationId: first.id, channel: "SMS", provider: "simulation", to: first.address, body: "x", idempotencyKey: `${c.id}:${first.id}:initial`, status: "SENT", attempts: 1 } });
    await db().messageJob.create({ data: { organizationId: a.orgId, invitationId: rest[0].id, channel: "SMS", provider: "simulation", to: rest[0].address, body: "x", idempotencyKey: `${c.id}:${rest[0].id}:initial`, status: "QUEUED" } });
    const { cancelRemainingSends } = await import("@/server/modules/digital/service");
    const v = (await db().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).version;
    await expect(cancelRemainingSends(a.ctx, c.id)).rejects.toThrow("errors.versionRequired");
    expect(await cancelRemainingSends(a.ctx, c.id, v)).toMatchObject({ cancelled: 1, status: "ACTIVE" });
    expect((await db().messageJob.findMany({ where: { invitation: { campaignId: c.id } }, select: { status: true } })).map((j) => j.status).sort()).toEqual(["CANCELLED", "SENT"]);
    expect(await db().digitalInvitation.count({ where: { campaignId: c.id, status: "CANCELLED" } })).toBe(2);
  });

  it("SW-5 a LIVE message stuck in SENDING for 11 minutes becomes FAILED outcome_unknown and is not re-sent; a SIMULATION one is retried", async () => {
    const { a, c } = await approvedCampaign(2);
    const [live, sim] = await db().digitalInvitation.findMany({ where: { campaignId: c.id }, orderBy: { id: "asc" } });
    await db().invitationCampaign.update({ where: { id: c.id }, data: { status: "SENDING", dispatchAttempts: 1, dispatchLeaseUntil: new Date(Date.now() + 10 * MIN) } });
    const liveJob = await db().messageJob.create({ data: { organizationId: a.orgId, invitationId: live.id, channel: "SMS", provider: "twilio", simulated: false, to: live.address, body: "x", idempotencyKey: `${c.id}:${live.id}:initial`, status: "SENDING", attempts: 1 } });
    const simJob = await db().messageJob.create({ data: { organizationId: a.orgId, invitationId: sim.id, channel: "SMS", provider: "simulation", simulated: true, to: sim.address, body: "x", idempotencyKey: `${c.id}:${sim.id}:initial`, status: "SENDING", attempts: 1 } });
    // a retry of the send itself never re-sends a message whose outcome is unknown
    expect(await sendMessageJob(a.orgId, liveJob.id)).toEqual({ skipped: true });
    // before 10 minutes nothing changes
    await recoverStalledWork(a.orgId);
    expect((await db().messageJob.findUniqueOrThrow({ where: { id: liveJob.id } })).status).toBe("SENDING");
    await recoverStalledWork(a.orgId, new Date(Date.now() + 11 * MIN));
    expect(await db().messageJob.findUniqueOrThrow({ where: { id: liveJob.id } })).toMatchObject({ status: "FAILED", lastError: "outcome_unknown", attempts: 1, sentAt: null });
    expect((await db().digitalInvitation.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("FAILED");
    expect((await db().messageJob.findUniqueOrThrow({ where: { id: simJob.id } })).status).toBe("SENT");
    const page = await getDigitalCampaign(a.ctx, c.id);
    expect(page.invitations.find((i) => i.id === live.id)?.lastError).toBe("outcome_unknown");
    expect((await systemHealth(a.ctx)).outcomeUnknown).toMatchObject({ count: 1, level: "warning" });
  });

  it("SW-6 a release 45 minutes after the send time sends nothing, shows the campaign as late, and tells the launcher once", async () => {
    const { a, c, ver } = await approvedCampaign(2, new Date(Date.now() + 2 * DAY));
    expect((await launchCampaign(a.ctx, c.id, await ver())).status).toBe("SCHEDULED");
    // the scheduler was down: the send time passed 45 minutes ago
    await db().invitationCampaign.update({ where: { id: c.id }, data: { scheduledAt: new Date(Date.now() - 45 * MIN) } });
    await dispatchDueCampaigns(a.orgId);
    expect(await dispatchCampaign(a.orgId, a.userId, c.id)).toMatchObject({ queued: 0 }); // a late delayed job
    expect((await recoverStalledWork(a.orgId)).held).toBe(1);
    await tickOrganization({ id: a.orgId, slug: a.slug, settings: {} });
    expect(await db().messageJob.count({ where: { invitation: { campaignId: c.id } } })).toBe(0);
    expect((await db().invitationCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("SCHEDULED");
    expect((await getDigitalCampaign(a.ctx, c.id)).send.late).toBe(true);
    expect(await db().notification.count({ where: { organizationId: a.orgId, userId: a.userId, type: "campaign.held_late", entityId: c.id } })).toBe(1);
    expect(await db().auditEvent.count({ where: { entityType: "CAMPAIGN", entityId: c.id, action: "campaign.held_late" } })).toBe(1);
    const h = await systemHealth(a.ctx);
    expect(h.stalled.level).toBe("critical");
    expect(h.stalled.sends.map((s) => s.id)).toContain(c.id);
  });

  it("SW-6 within 30 minutes of its time a scheduled send goes out normally", async () => {
    const { a, c, ver } = await approvedCampaign(2, new Date(Date.now() + 2 * DAY));
    await launchCampaign(a.ctx, c.id, await ver());
    await db().invitationCampaign.update({ where: { id: c.id }, data: { scheduledAt: new Date(Date.now() - 20 * MIN) } });
    await dispatchDueCampaigns(a.orgId);
    expect(await db().messageJob.count({ where: { invitation: { campaignId: c.id }, status: "SENT" } })).toBe(2);
    expect(await db().notification.count({ where: { organizationId: a.orgId, type: "campaign.held_late", entityId: c.id } })).toBe(0);
  });
});

describe("SW · System health (§7.4)", () => {
  it("SW-9 when the scheduler hasn't ticked for 20 minutes, System health shows a scheduler warning (critical after 60)", async () => {
    const a = await agency("health");
    await tickOrganization({ id: a.orgId, slug: a.slug, settings: {} });
    expect((await systemHealth(a.ctx)).scheduler.state).toBe("ok");
    expect((await systemHealth(a.ctx, new Date(Date.now() + 20 * MIN))).scheduler).toMatchObject({ state: "warning", ageMinutes: 20 });
    expect((await systemHealth(a.ctx, new Date(Date.now() + 61 * MIN))).scheduler.state).toBe("critical");
  });

  it("SW-9 System health is for owners and operations directors only", async () => {
    const a = await agency("health");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    await expect(systemHealth(pm.ctx)).rejects.toThrow("errors.forbidden");
    await expect(systemHealth(a.director.ctx)).resolves.toMatchObject({ outbox: { count: 0 } });
  });
});
