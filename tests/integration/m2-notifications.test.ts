/**
 * Milestone 2, Stream N — notification architecture (BUSINESS_RULES.md §3.1–3.3, NT-1/2/3/7).
 * In-app dedupe, the e-mail outbox (NotificationDelivery), retries with backoff → DEAD, the
 * idempotent compare-and-set claim, simulation, suppression and preferences.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { emit } from "@/server/modules/automation/outbox";
import { processOutbox } from "@/server/modules/automation/engine";
import { requestApproval } from "@/server/modules/approvals/service";
import { createProject, upsertProjectMember } from "@/server/modules/projects/service";
import { createTask } from "@/server/modules/tasks/service";
import { notify } from "@/server/modules/notifications/notify";
import { savePreference } from "@/server/modules/notifications/service";
import { EMAIL_BACKOFF_MS, listDeliveries, retryDelivery, sendDueDeliveries, maskEmail } from "@/server/modules/notifications/delivery";
import { setMailTransportForTests, type MailTransport } from "@/server/modules/email/transport";
import { renderNotificationEmail } from "@/server/modules/email/templates";
import { setMemberStatus } from "@/server/modules/org/service";
import { addMember, createAgency } from "../helpers";
import { startSmtpStub, type SmtpStub } from "../smtp-stub";

const MIN = 60_000;

async function project(ctx: Parameters<typeof createProject>[0], name = "Notify") {
  const { project } = await createProject(ctx, { name, type: "CUSTOM", priority: "MEDIUM", currency: "SAR", clientPortal: true, venueIds: [], templateIds: [] });
  return project;
}

async function liveEmail(orgId: string) {
  await adminDb().providerConfig.updateMany({ where: { organizationId: orgId, channel: "EMAIL" }, data: { mode: "LIVE", provider: "smtp" } });
}

const deliveries = (orgId: string) => adminDb().notificationDelivery.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } });

/** One mandatory notice with e-mail for `userId`; returns the delivery row. */
async function oneMandatoryNotice(orgId: string, userId: string, key = `nt:${Math.random()}`) {
  await withTenant({ orgId }, (tx) => notify(tx, { orgId, userIds: [userId], type: "approval.requested", titleKey: "notif.approvalRequested", params: { title: "Venue contract" }, link: "/projects/x/approvals", dedupeKey: key }));
  return adminDb().notificationDelivery.findFirstOrThrow({ where: { organizationId: orgId, dedupeKey: `${key}:${userId}:email` } });
}

describe("NT — notification architecture", () => {
  let smtp: SmtpStub;
  const prevSmtp = process.env.SMTP_URL;
  beforeAll(async () => {
    smtp = await startSmtpStub();
  });
  afterAll(async () => {
    await smtp.close();
  });
  afterEach(() => {
    process.env.SMTP_URL = prevSmtp ?? "";
    if (!prevSmtp) delete process.env.SMTP_URL;
    setMailTransportForTests(null);
    smtp.rcptReply = () => "250 2.1.5 OK";
  });

  it("NT-1 an approval with three eligible approvers creates three in-app notices and three e-mail deliveries; an identical emit creates none", async () => {
    const a = await createAgency("NT1");
    const pm1 = await addMember(a.ctx, "project_manager", "PM One");
    const pm2 = await addMember(a.ctx, "project_manager", "PM Two");
    const pm3 = await addMember(a.ctx, "project_manager", "PM Three");
    const emp = await addMember(a.ctx, "employee", "Requester");
    const p = await project(pm1.ctx);
    for (const u of [pm2, pm3]) await upsertProjectMember(pm1.ctx, { projectId: p.id, userId: u.userId, role: "MANAGER", canApprove: true, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    await upsertProjectMember(pm1.ctx, { projectId: p.id, userId: emp.userId, role: "MEMBER", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    const t = await createTask(emp.ctx, { projectId: p.id, title: "Venue contract", priority: "MEDIUM", requiresApproval: false, clientVisible: false, tags: [] });
    const ap = await requestApproval(emp.ctx, { projectId: p.id, entityType: "TASK", entityId: t.id, title: "Venue contract", approverType: "INTERNAL", approverUserId: null });
    await processOutbox(a.orgId);
    const notices = () => adminDb().notification.findMany({ where: { organizationId: a.orgId, type: "approval.requested", entityId: t.id } });
    const mail = () => adminDb().notificationDelivery.findMany({ where: { organizationId: a.orgId, params: { path: ["type"], equals: "approval.requested" } } });
    expect((await notices()).map((n) => n.userId).sort()).toEqual([pm1.userId, pm2.userId, pm3.userId].sort());
    expect(await mail()).toHaveLength(3);
    expect((await mail()).every((d) => d.status === "PENDING" && d.channel === "EMAIL")).toBe(true);
    // the same occurrence announced again (a replayed or duplicated event) creates nothing
    const ev = await adminDb().outboxEvent.findFirstOrThrow({ where: { organizationId: a.orgId, type: "approval.requested" } });
    await withTenant({ orgId: a.orgId }, (tx) => emit(tx, emp.ctx, "approval.requested", ev.payload as Record<string, unknown>));
    await processOutbox(a.orgId);
    expect(await notices()).toHaveLength(3);
    expect(await mail()).toHaveLength(3);
    expect(ap.status).toBe("PENDING");
  });

  it("notify() dedupes per key and user; without a key every call is a new notice", async () => {
    const a = await createAgency("NTDedupe");
    const pm = await addMember(a.ctx, "project_manager", "PM");
    const send = (key?: string) => withTenant({ orgId: a.orgId }, (tx) => notify(tx, { orgId: a.orgId, userIds: [pm.userId, a.userId], type: "task.escalated", titleKey: "notif.taskEscalated", params: { title: "X" }, dedupeKey: key }));
    expect(await send("k1")).toBe(2);
    expect(await send("k1")).toBe(0);
    expect(await send("k2")).toBe(2);
    const rows = await adminDb().notification.findMany({ where: { organizationId: a.orgId, type: "task.escalated" } });
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(4);
    // one e-mail per notice, keyed ‹notice key›:email
    const mail = await deliveries(a.orgId);
    expect(mail.map((d) => d.dedupeKey).sort()).toEqual(rows.map((r) => `${r.dedupeKey}:email`).sort());
  });

  it("NT-2 without SMTP a mandatory notice's e-mail ends SIMULATED and no surface reports it as sent", async () => {
    delete process.env.SMTP_URL;
    const a = await createAgency("NT2");
    await liveEmail(a.orgId); // LIVE is chosen but there is no transport: still simulated
    const d = await oneMandatoryNotice(a.orgId, a.userId);
    const r = await sendDueDeliveries(a.orgId);
    expect(r).toMatchObject({ claimed: 1, simulated: 1, sent: 0 });
    const after = await adminDb().notificationDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.status).toBe("SIMULATED");
    expect(after.sentAt).toBeNull();
    expect(after.providerMessageId).toBeNull();
    const n = await adminDb().notification.findUniqueOrThrow({ where: { id: after.notificationId! } });
    expect(n.emailedAt, "the in-app notice never says it was e-mailed").toBeNull();
    const log = await listDeliveries(a.ctx);
    expect(log.mode).toBe("SIMULATION");
    expect(log.counts.SENT ?? 0).toBe(0);
    expect(log.rows.find((x) => x.id === d.id)?.status).toBe("SIMULATED");
    // the organisation's channel in SIMULATION also simulates, even with SMTP configured
    process.env.SMTP_URL = smtp.url;
    const b = await createAgency("NT2b");
    const d2 = await oneMandatoryNotice(b.orgId, b.userId);
    await sendDueDeliveries(b.orgId);
    expect((await adminDb().notificationDelivery.findUniqueOrThrow({ where: { id: d2.id } })).status).toBe("SIMULATED");
    expect(smtp.messages.filter((m) => m.to.includes(b.email))).toHaveLength(0);
  });

  it("NT-3 four SMTP 4xx failures then success: SENT with attempts = 5, retried on the 1 m / 5 m / 30 m / 2 h backoff", async () => {
    process.env.SMTP_URL = smtp.url;
    const a = await createAgency("NT3");
    await liveEmail(a.orgId);
    const d = await oneMandatoryNotice(a.orgId, a.userId);
    let fails = 4;
    smtp.rcptReply = () => (fails-- > 0 ? "451 4.3.0 Mailbox temporarily unavailable" : "250 2.1.5 OK");
    let now = new Date();
    const row = () => adminDb().notificationDelivery.findUniqueOrThrow({ where: { id: d.id } });
    for (let i = 0; i < 4; i++) {
      await sendDueDeliveries(a.orgId, { now });
      const r = await row();
      expect(r.status).toBe("FAILED");
      expect(r.attempts).toBe(i + 1);
      expect(r.lastError).toMatch(/451/);
      expect(r.nextAttemptAt.getTime() - now.getTime()).toBe(EMAIL_BACKOFF_MS[i]);
      // not due yet: a sweep before nextAttemptAt does nothing
      expect((await sendDueDeliveries(a.orgId, { now: new Date(r.nextAttemptAt.getTime() - 1000) })).claimed).toBe(0);
      now = r.nextAttemptAt;
    }
    await sendDueDeliveries(a.orgId, { now });
    const done = await row();
    expect(done.status).toBe("SENT");
    expect(done.attempts).toBe(5);
    expect(done.providerMessageId).toBeTruthy();
    expect(done.sentAt).not.toBeNull();
    const sent = smtp.messages.filter((m) => m.to.includes(a.email));
    expect(sent).toHaveLength(1);
    expect(sent[0].raw).toContain(`X-Opera-Ref: ${d.id}`);
    expect((await adminDb().notification.findUniqueOrThrow({ where: { id: done.notificationId! } })).emailedAt).not.toBeNull();
  });

  it("NT-3 five transient failures make the delivery DEAD; a 5xx is DEAD at once; retry puts it back (audited)", async () => {
    process.env.SMTP_URL = smtp.url;
    const a = await createAgency("NT3Dead");
    await liveEmail(a.orgId);
    smtp.rcptReply = () => "451 4.4.1 try later";
    const d = await oneMandatoryNotice(a.orgId, a.userId);
    let now = new Date();
    for (let i = 0; i < 5; i++) {
      await sendDueDeliveries(a.orgId, { now });
      now = new Date(now.getTime() + 7 * 3600_000);
    }
    const dead = await adminDb().notificationDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(dead.status).toBe("DEAD");
    expect(dead.attempts).toBe(5);
    expect((await sendDueDeliveries(a.orgId, { now: new Date(now.getTime() + 86400_000) })).claimed, "DEAD is terminal").toBe(0);
    const log = await listDeliveries(a.ctx, { status: "DEAD" });
    expect(log.counts.DEAD).toBe(1);
    expect(log.rows.map((r) => r.id)).toEqual([d.id]);
    expect(log.rows[0].to).toBe(maskEmail(a.email));
    expect(log.rows[0].to).not.toContain(a.email.split("@")[0]);

    smtp.rcptReply = () => "550 5.1.1 No such user";
    const p = await oneMandatoryNotice(a.orgId, a.userId);
    await sendDueDeliveries(a.orgId);
    const perm = await adminDb().notificationDelivery.findUniqueOrThrow({ where: { id: p.id } });
    expect(perm.status).toBe("DEAD");
    expect(perm.attempts).toBe(1);

    smtp.rcptReply = () => "250 OK";
    await retryDelivery(a.ctx, { id: d.id });
    const back = await adminDb().notificationDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(back).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(await adminDb().auditEvent.count({ where: { organizationId: a.orgId, action: "notification.delivery_retry", entityId: d.id } })).toBe(1);
    await sendDueDeliveries(a.orgId);
    expect((await adminDb().notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("SENT");
    // a director without org.manage? directors have it; a PM does not see the log
    const pm = await addMember(a.ctx, "project_manager", "PM");
    await expect(listDeliveries(pm.ctx)).rejects.toThrow();
  });

  it("the claim is a compare-and-set: concurrent sweeps send every delivery exactly once", async () => {
    const a = await createAgency("NTClaim");
    await liveEmail(a.orgId);
    const sends: string[] = [];
    const slow: MailTransport = {
      async sendMail(msg) {
        sends.push(msg.headers["X-Opera-Ref"]);
        await new Promise((r) => setTimeout(r, 30));
        return { messageId: `<${msg.headers["X-Opera-Ref"]}@test>` };
      },
    };
    setMailTransportForTests(slow);
    const members = await Promise.all(Array.from({ length: 4 }, (_, i) => addMember(a.ctx, "employee", `E${i}`)));
    for (let i = 0; i < 5; i++) {
      await withTenant({ orgId: a.orgId }, (tx) => notify(tx, { orgId: a.orgId, userIds: members.map((m) => m.userId), type: "approval.requested", titleKey: "notif.approvalRequested", params: { title: `T${i}` }, dedupeKey: `claim:${i}` }));
    }
    const rows = await deliveries(a.orgId);
    expect(rows).toHaveLength(20);
    const results = await Promise.all([sendDueDeliveries(a.orgId), sendDueDeliveries(a.orgId), sendDueDeliveries(a.orgId), sendDueDeliveries(a.orgId)]);
    expect(results.reduce((s, r) => s + r.claimed, 0)).toBe(20);
    expect(sends).toHaveLength(20);
    expect(new Set(sends).size).toBe(20);
    expect((await deliveries(a.orgId)).every((d) => d.status === "SENT" && d.attempts === 1)).toBe(true);
  });

  it("a delivery stuck in SENDING for more than 10 minutes is reclaimed (crash recovery); a fresh SENDING row is not", async () => {
    const a = await createAgency("NTReclaim");
    await liveEmail(a.orgId);
    setMailTransportForTests({ sendMail: async () => ({ messageId: "<ok@test>" }) });
    const d = await oneMandatoryNotice(a.orgId, a.userId);
    const now = new Date();
    await adminDb().notificationDelivery.update({ where: { id: d.id }, data: { status: "SENDING", attempts: 1, updatedAt: new Date(now.getTime() - 5 * MIN) } });
    expect((await sendDueDeliveries(a.orgId, { now })).claimed).toBe(0);
    await adminDb().notificationDelivery.update({ where: { id: d.id }, data: { updatedAt: new Date(now.getTime() - 11 * MIN) } });
    expect((await sendDueDeliveries(a.orgId, { now })).claimed).toBe(1);
    expect(await adminDb().notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "SENT", attempts: 2 });
  });

  it("NT-7 an e-mail opt-out for task.assigned creates no delivery; mandatory approval.requested can't be switched off", async () => {
    const a = await createAgency("NT7");
    const emp = await addMember(a.ctx, "employee", "Employee");
    await savePreference(emp.ctx, { type: "task.assigned", inApp: true, email: false, digest: "none" });
    const p = await project(a.ctx);
    await upsertProjectMember(a.ctx, { projectId: p.id, userId: emp.userId, role: "MEMBER", canApprove: false, canExport: false, canViewFinance: false, canViewVip: false, workstreamIds: [] });
    await createTask(a.ctx, { projectId: p.id, title: "Brief", priority: "LOW", requiresApproval: false, clientVisible: false, tags: [], ownerId: emp.userId });
    await processOutbox(a.orgId);
    expect(await adminDb().notification.count({ where: { organizationId: a.orgId, userId: emp.userId, type: "task.assigned" } })).toBe(1);
    expect(await adminDb().notificationDelivery.count({ where: { organizationId: a.orgId, userId: emp.userId } })).toBe(0);
    // default for an optional type is on: the owner (no preference) would get the e-mail
    await createTask(a.ctx, { projectId: p.id, title: "Brief 2", priority: "LOW", requiresApproval: false, clientVisible: false, tags: [], ownerId: a.userId });
    await processOutbox(a.orgId);
    expect(await adminDb().notificationDelivery.count({ where: { organizationId: a.orgId, userId: a.userId } })).toBe(0); // actor is excluded from their own assignment notice
    await expect(savePreference(emp.ctx, { type: "approval.requested", inApp: true, email: false, digest: "none" })).rejects.toThrow("notif.mandatoryHint");
    await expect(savePreference(emp.ctx, { type: "approval.requested", inApp: false, email: true, digest: "none" })).rejects.toThrow("notif.mandatoryHint");
    // even a stored opt-out (e.g. "*" off) never stops a mandatory notice or its e-mail
    await savePreference(emp.ctx, { type: "*", inApp: false, email: false, digest: "none" });
    const d = await oneMandatoryNotice(a.orgId, emp.userId);
    expect(d.status).toBe("PENDING");
    // …while an optional one is fully muted by "*"
    await withTenant({ orgId: a.orgId }, (tx) => notify(tx, { orgId: a.orgId, userIds: [emp.userId], type: "task.overdue", titleKey: "notif.taskOverdue", params: { title: "x" } }));
    expect(await adminDb().notification.count({ where: { organizationId: a.orgId, userId: emp.userId, type: "task.overdue" } })).toBe(0);
    // the caller's `mandatory` flag (e.g. "return to office") overrides an in-app opt-out
    await withTenant({ orgId: a.orgId }, (tx) => notify(tx, { orgId: a.orgId, userIds: [emp.userId], type: "project.cancelled", titleKey: "notif.types.projectCancelled", mandatory: true }));
    expect(await adminDb().notification.count({ where: { organizationId: a.orgId, userId: emp.userId, type: "project.cancelled" } })).toBe(1);
  });

  it("recipients are active members only; a recipient suspended before the send is SUPPRESSED", async () => {
    const a = await createAgency("NTSuppress");
    await liveEmail(a.orgId);
    setMailTransportForTests({ sendMail: async () => ({ messageId: "<ok@test>" }) });
    const emp = await addMember(a.ctx, "employee", "Leaving");
    const d = await oneMandatoryNotice(a.orgId, emp.userId);
    const membership = await adminDb().membership.findFirstOrThrow({ where: { organizationId: a.orgId, userId: emp.userId } });
    await setMemberStatus(a.ctx, { membershipId: membership.id, status: "SUSPENDED" } as never);
    await sendDueDeliveries(a.orgId);
    expect((await adminDb().notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("SUPPRESSED");
    // and no new notice reaches them at all
    expect(await withTenant({ orgId: a.orgId }, (tx) => notify(tx, { orgId: a.orgId, userIds: [emp.userId], type: "approval.requested", titleKey: "notif.approvalRequested" }))).toBe(0);
  });

  it("e-mail renders in the recipient's language and direction, with a deep link and no contact data", () => {
    const p = { type: "task.escalated", titleKey: "notif.taskEscalated", params: { code: "PRJ-1-21", title: "Receive guest list", days: 2, owner: "Reem" }, link: "/tasks/t1", surface: "o" as const, priority: "HIGH" as const, escalationLevel: 2 };
    const ar = renderNotificationEmail("ar", p, { orgSlug: "acme", orgName: "Acme" });
    const en = renderNotificationEmail("en", p, { orgSlug: "acme", orgName: "Acme" });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.html).toContain('lang="ar"');
    expect(en.html).toContain('dir="ltr"');
    expect(en.subject).toBe("Opera — Escalated: PRJ-1-21 Receive guest list — 2 days late · owner Reem");
    expect(ar.subject.startsWith("Opera — تصعيد")).toBe(true);
    expect(en.text).toContain("/o/acme/tasks/t1");
    expect(en.html).not.toMatch(/Operra/);
    // a portal user's link opens their portal, not the agency workspace
    const portal = renderNotificationEmail("en", { ...p, surface: "portal", link: "/projects/p1/approvals" }, { orgSlug: "acme", orgName: "Acme" });
    expect(portal.text).toContain("/portal/acme/projects/p1");
    // HTML is escaped
    const xss = renderNotificationEmail("en", { ...p, params: { ...p.params, title: "<script>x</script>" } }, { orgSlug: "acme", orgName: "Acme" });
    expect(xss.html).not.toContain("<script>x");
  });
});
