/**
 * ARCH-AUDIT probes (Agent 2). Assert intended behaviour; failures document live defects.
 */
import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { createProject, setProjectStatus, updateProject, upsertProjectMember } from "@/server/modules/projects/service";
import { addComment, bulkUpdateTasks, createTask } from "@/server/modules/tasks/service";
import { commandCenter, createEvent, reportIncident } from "@/server/modules/events/service";
import { arrivalsBoard, saveGuest } from "@/server/modules/protocol/service";
import { listProjects } from "@/server/modules/projects/service";
import { portalProject } from "@/server/modules/portal/service";
import { saveClient } from "@/server/modules/org/service";
import { commitImport, configureAndValidate, createImport, listImportRows, rollbackImport } from "@/server/modules/delivery/imports/service";
import { anonymizeRecipients, bulkAssign, updateDeliveryStatus } from "@/server/modules/delivery/service";
import { addAudience, saveDigitalCampaign } from "@/server/modules/digital/service";
import { dispatchCampaign } from "@/server/modules/digital/sender";
import { storeAttachment } from "@/server/modules/files/service";
import { schedulerTick } from "@/server/modules/automation/scheduler";
import { addMember, createAgency } from "../../helpers";

const tpl = (orgId: string, key: string) => withTenant({ orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: orgId, key } } })).id);
// this file registers many agencies from one "IP": relax the registration rate limit (non-production only)
process.env.RATE_LIMIT_MULTIPLIER ??= "50";
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

describe("arch-audit: external-role boundary (agency workspace pages render for clients/drivers via RSC)", () => {
  it("a client user gets no internal incidents from the command center", async () => {
    const a = await createAgency("ArchBoundary");
    const client = await saveClient(a.ctx, { name: "Client Co" } as never);
    const { project } = await createProject(a.ctx, { name: "Summit", type: "EVENT", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [], clientId: client.id });
    const now = Date.now();
    const ev = await createEvent(a.ctx, { projectId: project.id, name: "Opening", startsAt: new Date(now + 3600_000), endsAt: new Date(now + 5 * 3600_000) });
    await reportIncident(a.ctx, { projectId: project.id, eventId: ev.id, title: "Generator failure in hall B", severity: "HIGH" });
    const c = await addMember(a.ctx, "client_approver", "Client");
    await withTenant({ orgId: a.orgId }, (tx) => tx.membership.updateMany({ where: { userId: c.userId }, data: { clientId: client.id } }));
    await upsertProjectMember(a.ctx, { projectId: project.id, userId: c.userId, role: "CLIENT_APPROVER", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    const cc = await commandCenter(c.ctx).catch(() => ({ incidents: [] as unknown[] }));
    // SAFE: internal incident log is not client data
    expect(cc.incidents.length).toBe(0);
  });

  it("a field agent (auto-added project member) gets no VIP guest list from the arrivals board", async () => {
    const a = await createAgency("ArchArrivals");
    const { project } = await createProject(a.ctx, { name: "Summit", type: "EVENT", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [await tpl(a.orgId, "vip-physical-delivery")] });
    const now = Date.now();
    const ev = await createEvent(a.ctx, { projectId: project.id, name: "Royal dinner", startsAt: new Date(now + 3600_000), endsAt: new Date(now + 5 * 3600_000) });
    await saveGuest(a.ctx, { projectId: project.id, eventId: ev.id, nameAr: "صاحب السمو الضيف", category: "VVIP", protocolLevel: 1, arrivalPoint: "Gate 3 (private)" });
    const agent = await addMember(a.ctx, "field_agent", "Driver");
    await upsertProjectMember(a.ctx, { projectId: project.id, userId: agent.userId, role: "FIELD_AGENT", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    const board = await arrivalsBoard(agent.ctx).catch(() => ({ guests: [] as unknown[] }));
    expect(board.guests.length).toBe(0);
    const portfolio = await listProjects(agent.ctx).catch(() => []);
    expect(portfolio.length).toBe(0);
  });

  it("a client user's global search does not return internal (non client-visible) task titles", async () => {
    const { globalSearch } = await import("@/server/modules/search/service");
    const a = await createAgency("ArchSearch");
    const client = await saveClient(a.ctx, { name: "Client Co" } as never);
    const { project } = await createProject(a.ctx, { name: "Summit", type: "EVENT", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [], clientId: client.id });
    await createTask(a.ctx, { projectId: project.id, title: "Negotiate discount with venue (internal)", priority: "LOW", requiresApproval: false, clientVisible: false, tags: [] });
    const c = await addMember(a.ctx, "client", "Client");
    await withTenant({ orgId: a.orgId }, (tx) => tx.membership.updateMany({ where: { userId: c.userId }, data: { clientId: client.id } }));
    await upsertProjectMember(a.ctx, { projectId: project.id, userId: c.userId, role: "CLIENT_VIEWER", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    const hits = await globalSearch({ ...c.ctx, clientId: client.id }, "Negotiate");
    expect(hits.filter((h) => h.kind === "task").map((h) => h.title)).toEqual([]);
  });

  it("re-assigning a project to another client removes the previous client's portal access", async () => {
    const a = await createAgency("ArchClientSwap");
    const c1 = await saveClient(a.ctx, { name: "First Client" } as never);
    const c2 = await saveClient(a.ctx, { name: "Second Client" } as never);
    const { project } = await createProject(a.ctx, { name: "Shared", type: "EVENT", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [], clientId: c1.id });
    const u = await addMember(a.ctx, "client", "C1 user");
    await withTenant({ orgId: a.orgId }, (tx) => tx.membership.updateMany({ where: { userId: u.userId }, data: { clientId: c1.id } }));
    const uctx = { ...u.ctx, clientId: c1.id };
    await upsertProjectMember(a.ctx, { projectId: project.id, userId: u.userId, role: "CLIENT_VIEWER", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    await updateProject(a.ctx, project.id, { name: "Shared", type: "EVENT", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], clientId: c2.id });
    // SAFE: first client's user no longer sees the (now second client's) project
    await expect(portalProject(uctx, project.id)).rejects.toThrow();
  });
});

async function importCsv(ctx: Awaited<ReturnType<typeof createAgency>>["ctx"], projectId: string, campaignId: string | null, csv: string, scope: "PROJECT" | "ORGANIZATION") {
  const batch = await createImport(ctx, { projectId, campaignId, fileName: "list.csv", declaredType: "text/csv", body: Buffer.from(csv, "utf8") });
  await configureAndValidate(ctx, { batchId: batch.id, sheetName: batch.sheetName!, headerRow: batch.headerRow, mapping: { nameAr: "الاسم", mobile: "الجوال", address: "العنوان", city: "المدينة" }, options: { duplicateScope: scope, matchOn: ["mobile"], requireMobile: true, requireLocation: true } });
  return batch.id;
}

describe("arch-audit: VIP data across project boundaries and erasure", () => {
  it("org-wide duplicate detection does not reveal another project's VIP name and unmasked mobile", async () => {
    const a = await createAgency("ArchDupLeak");
    const { project: secret } = await createProject(a.ctx, { name: "Royal court (restricted)", type: "VIP_DELIVERY", priority: "CRITICAL", currency: "SAR", clientPortal: false, venueIds: [], templateIds: [] });
    await withTenant({ orgId: a.orgId }, (tx) => tx.recipient.create({ data: { organizationId: a.orgId, projectId: secret.id, code: "R-00001", nameAr: "الأمير المحجوب", mobile: "+966500000777", createdById: a.userId } }));
    // a PM who is NOT a member of the restricted project, with VIP scope on their own project
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const { project: mine } = await createProject(pm.ctx, { name: "Mine", type: "VIP_DELIVERY", priority: "LOW", currency: "SAR", clientPortal: false, venueIds: [], templateIds: [] });
    const batchId = await importCsv(pm.ctx, mine.id, null, "الاسم,الجوال,العنوان,المدينة\nضيف,0500000777,حي النرجس,الرياض\n", "ORGANIZATION");
    const rows = await listImportRows(pm.ctx, batchId);
    const leaked = Object.values(rows.duplicates);
    // SAFE: nothing from the restricted project is returned to a non-member
    expect({ nameLeaked: leaked.some((d) => d.nameAr === "الأمير المحجوب"), mobileLeakedUnmasked: leaked.some((d) => d.mobile === "+966500000777"), projectLeaked: leaked.some((d) => d.projectId === secret.id) }).toEqual({ nameLeaked: false, mobileLeakedUnmasked: false, projectLeaked: false });
  });

  it("rolling back an import refuses when its recipients are already in a digital campaign audience", async () => {
    const a = await createAgency("ArchRollback");
    const { project } = await createProject(a.ctx, { name: "Gala", type: "EVENT", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [await tpl(a.orgId, "vip-digital-campaign")] });
    const batchId = await importCsv(a.ctx, project.id, null, "الاسم,الجوال,العنوان,المدينة\nضيف أول,0551110001,حي الملقا,الرياض\nضيف ثان,0551110002,حي الملقا,الرياض\n", "PROJECT");
    await commitImport(a.ctx, { batchId, includeWarnings: true, acceptPartial: true });
    const rec = await withTenant({ orgId: a.orgId }, (tx) => tx.recipient.findMany({ where: { importBatchId: batchId } }));
    const draft = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: project.id, type: "DIGITAL" } }));
    await saveDigitalCampaign(a.ctx, { id: draft.id, projectId: project.id, name: "Invite", channel: "SMS", bodyTemplate: "مرحبا {{name}} {{rsvp_link}}", rsvpEnabled: true, qrEnabled: false });
    await addAudience(a.ctx, { campaignId: draft.id, recipientIds: rec.map((r) => r.id) });
    // SAFE: rollback must be refused (or clean up the audience); today it hard-deletes recipients and leaves dangling invitations
    const rolledBack = await rollbackImport(a.ctx, batchId).then(() => true, () => false);
    let dispatchError: string | null = null;
    if (rolledBack) {
      await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.update({ where: { id: draft.id }, data: { status: "SENDING" } }));
      // a dispatch over the now-dangling audience
      dispatchError = await dispatchCampaign(a.orgId, a.userId, draft.id).then(() => null, (e: Error) => e.message.slice(0, 80));
    }
    expect({ rolledBack, dispatchError }).toEqual({ rolledBack: false, dispatchError: null });
  });

  it("anonymising recipients also erases the PII copied into guests, invitations and import rows", async () => {
    const a = await createAgency("ArchPdpl");
    const { project } = await createProject(a.ctx, { name: "Gala", type: "EVENT", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [await tpl(a.orgId, "vip-digital-campaign")] });
    const batchId = await importCsv(a.ctx, project.id, null, "الاسم,الجوال,العنوان,المدينة\nمعالي المدعو,0552220001,حي السفارات,الرياض\n", "PROJECT");
    await commitImport(a.ctx, { batchId, includeWarnings: true, acceptPartial: true });
    const [r] = await withTenant({ orgId: a.orgId }, (tx) => tx.recipient.findMany({ where: { importBatchId: batchId } }));
    const { importGuestsFromRecipients } = await import("@/server/modules/protocol/service");
    await importGuestsFromRecipients(a.ctx, { projectId: project.id });
    const draft = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: project.id, type: "DIGITAL" } }));
    await saveDigitalCampaign(a.ctx, { id: draft.id, projectId: project.id, name: "Invite", channel: "SMS", bodyTemplate: "مرحبا {{name}} {{rsvp_link}}", rsvpEnabled: true, qrEnabled: false });
    await addAudience(a.ctx, { campaignId: draft.id, recipientIds: [r.id] });
    await anonymizeRecipients(a.ctx, { projectId: project.id, recipientIds: [r.id] });
    const left = await withTenant({ orgId: a.orgId }, async (tx) => ({
      guest: await tx.guest.findFirst({ where: { recipientId: r.id } }),
      inv: await tx.digitalInvitation.findFirst({ where: { recipientId: r.id } }),
      row: await tx.importRow.findFirst({ where: { batchId } }),
    }));
    expect({
      guestMobileKept: !!left.guest?.mobile,
      guestNameKept: left.guest?.nameAr === "معالي المدعو",
      invitationAddressKept: (left.inv?.address ?? "").includes("552220001"),
      importRowRawKept: JSON.stringify(left.row?.raw ?? {}).includes("0552220001"),
    }).toEqual({ guestMobileKept: false, guestNameKept: false, invitationAddressKept: false, importRowRawKept: false });
  });
});

describe("arch-audit: lifecycle & scope", () => {
  it("cancelling a project stops overdue reminders/escalations for its open tasks", async () => {
    const a = await createAgency("ArchCancel");
    const { project } = await createProject(a.ctx, { name: "Dropped", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
    await createTask(a.ctx, { projectId: project.id, title: "Late item", priority: "LOW", requiresApproval: false, clientVisible: false, tags: [], ownerId: a.userId, dueAt: new Date(Date.now() - 3600_000) });
    await setProjectStatus(a.ctx, project.id, "CANCELLED");
    await schedulerTick(new Date());
    const n = await withTenant({ orgId: a.orgId }, (tx) => tx.outboxEvent.count({ where: { type: "task.overdue" } }));
    expect(n).toBe(0);
  });

  it("a freelancer (task-scoped contractor) cannot create or complete project milestones", async () => {
    const { saveMilestone } = await import("@/server/modules/projects/service");
    const a = await createAgency("ArchFreelancer");
    const { project } = await createProject(a.ctx, { name: "P", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
    const f = await addMember(a.ctx, "freelancer", "Contractor");
    await upsertProjectMember(a.ctx, { projectId: project.id, userId: f.userId, role: "FREELANCER", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    const created = await saveMilestone(f.ctx, { projectId: project.id, title: "Venue handed over", status: "DONE", clientVisible: true }).then(() => true, () => false);
    expect(created).toBe(false);
  });

  it("an ops director cannot suspend or demote an agency owner", async () => {
    const { setMemberStatus } = await import("@/server/modules/org/service");
    const a = await createAgency("ArchHierarchy");
    const owner2 = await addMember(a.ctx, "owner", "Co-owner");
    const director = await addMember(a.ctx, "ops_director", "Director");
    const m = await withTenant({ orgId: a.orgId }, (tx) => tx.membership.findFirstOrThrow({ where: { userId: owner2.userId } }));
    const suspended = await setMemberStatus(director.ctx, { membershipId: m.id, status: "SUSPENDED" }).then(() => true, () => false);
    expect(suspended).toBe(false);
  });

  it("bulk task update honours a member's workstream restriction", async () => {
    const a = await createAgency("ArchWs");
    const { project } = await createProject(a.ctx, { name: "Conf", type: "CONFERENCE", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [await tpl(a.orgId, "conference"), await tpl(a.orgId, "vip-physical-delivery")] });
    const ws = await withTenant({ orgId: a.orgId }, (tx) => tx.workstream.findMany({ where: { projectId: project.id }, orderBy: { key: "asc" } }));
    const [allowed, forbidden] = ws;
    const lead = await addMember(a.ctx, "team_lead", "Lead");
    await upsertProjectMember(a.ctx, { projectId: project.id, userId: lead.userId, role: "LEAD", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [allowed.id] });
    const hidden = await withTenant({ orgId: a.orgId }, (tx) => tx.task.findFirstOrThrow({ where: { projectId: project.id, workstreamId: forbidden.id } }));
    await bulkUpdateTasks(lead.ctx, { projectId: project.id, taskIds: [hidden.id], set: { priority: "CRITICAL", addTag: "tampered" } }).catch(() => null);
    const after = await withTenant({ orgId: a.orgId }, (tx) => tx.task.findUniqueOrThrow({ where: { id: hidden.id } }));
    expect(after.tags).not.toContain("tampered");
  });

  it("comments cannot be attached to an entity of another project", async () => {
    const a = await createAgency("ArchComment");
    const { project: p1 } = await createProject(a.ctx, { name: "P1", type: "BOOTH", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [await tpl(a.orgId, "booth-production")] });
    const { project: p2 } = await createProject(a.ctx, { name: "P2", type: "CUSTOM", priority: "LOW", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
    const booth = await withTenant({ orgId: a.orgId }, (tx) => tx.booth.findFirstOrThrow({ where: { projectId: p1.id } }));
    const emp = await addMember(a.ctx, "employee", "Emp");
    await upsertProjectMember(a.ctx, { projectId: p2.id, userId: emp.userId, role: "MEMBER", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    const posted = await addComment(emp.ctx, { entityType: "BOOTH", entityId: booth.id, projectId: p2.id, body: "injected from another project", visibility: "CLIENT" }).then(() => true, () => false);
    expect(posted).toBe(false);
  });

  it("a delivery cannot exceed the campaign's maxAttempts", async () => {
    const a = await createAgency("ArchAttempts");
    const { project } = await createProject(a.ctx, { name: "Summit", type: "CONFERENCE", priority: "HIGH", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [await tpl(a.orgId, "vip-physical-delivery")] });
    const campaign = await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: project.id, type: "PHYSICAL" } }));
    await withTenant({ orgId: a.orgId }, (tx) => tx.invitationCampaign.update({ where: { id: campaign.id }, data: { config: { requireEvidence: false, requireReceiverName: false, maxAttempts: 1 } } }));
    const batchId = await importCsv(a.ctx, project.id, campaign.id, "الاسم,الجوال,العنوان,المدينة\nضيف,0553330001,حي العليا,الرياض\n", "PROJECT");
    await commitImport(a.ctx, { batchId, includeWarnings: true, acceptPartial: true });
    const d = await withTenant({ orgId: a.orgId }, (tx) => tx.delivery.findFirstOrThrow({ where: { campaignId: campaign.id } }));
    const agent = await addMember(a.ctx, "field_agent", "Driver");
    await bulkAssign(a.ctx, { projectId: project.id, deliveryIds: [d.id], agentId: agent.userId, overrideCapacity: false });
    await updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "OUT_FOR_DELIVERY", evidenceIds: [], source: "FIELD" });
    await updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "FAILED_ATTEMPT", reason: "NO_ANSWER", evidenceIds: [], source: "FIELD" });
    // attempt #2 should be refused (maxAttempts = 1) — today the config value is never read
    const second = await updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "OUT_FOR_DELIVERY", evidenceIds: [], source: "FIELD" }).then(() => true, () => false);
    expect(second).toBe(false);
    void storeAttachment; void PNG;
  });
});
