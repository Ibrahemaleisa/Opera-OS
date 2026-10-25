/**
 * Synthetic demo data for local evaluation. Everything goes through the real service layer
 * (permissions, state machines, audit, approvals), so the seeded data obeys the same rules as the UI.
 * All names, organisations and phone numbers are fictional — no real VIP identities.
 *
 *   pnpm db:seed                       # creates the "demo" agency if it doesn't exist
 *   SEED_PASSWORD=... pnpm db:seed     # choose the demo password (default printed at the end)
 */
import "dotenv/config";
process.env.JOBS_MODE = "inline"; // run imports, campaign sends and automations in-process
process.env.WEBHOOK_SECRET_SIMULATION ??= "seed-only-simulation-secret";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "@/lib/id";
import { hashPassword } from "@/server/auth/password";
import type { ServiceContext } from "@/server/authz/context";
import { loadServiceContext } from "@/server/authz/load-context";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { registerAgency } from "@/server/modules/auth/service";
import { saveClient, saveVenue } from "@/server/modules/org/service";
import { createProject, upsertProjectMember } from "@/server/modules/projects/service";
import { decideApproval } from "@/server/modules/approvals/service";
import { storeAttachment } from "@/server/modules/files/service";
import { commitImport, configureAndValidate, createImport, resolveRows } from "@/server/modules/delivery/imports/service";
import { bulkAssign, updateDeliveryStatus } from "@/server/modules/delivery/service";
import { addAudience, launchCampaign, requestCampaignApproval, saveDigitalCampaign, submitRsvp } from "@/server/modules/digital/service";
import { reportIncident, saveRunItem, saveSession, saveShift, saveSpeaker, setReadinessStatus, setRunItemStatus } from "@/server/modules/events/service";
import { assignSeat, importGuestsFromRecipients, saveZone, setAttendance } from "@/server/modules/protocol/service";
import { createRevision, recordInspection, saveBoqItem, saveBooth, saveSnag, setBoothStage, submitRevision } from "@/server/modules/booths/service";
import { awardQuote, createRfq, createWorkOrder, recordQuote, saveVendor, setWorkOrderStatus } from "@/server/modules/vendors/service";
import { createChangeOrder, createExpense, requestExpenseApproval, saveBudget, setContractValue, submitPurchaseOrder } from "@/server/modules/finance/service";
import { createChangeRequest } from "@/server/modules/portal/service";

const SLUG = process.env.SEED_ORG_SLUG ?? "demo";
const PASSWORD = process.env.SEED_PASSWORD ?? "Opera-Demo-2026";
const DOMAIN = SLUG === "demo" ? "opera.demo" : `${SLUG}.opera.demo`;
// demo agencies seeded before the naming was standardised use this domain
const LEGACY_DOMAIN = SLUG === "demo" ? "operra.demo" : `${SLUG}.operra.demo`;
const DAY = 86400_000;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

async function ctxFor(userId: string): Promise<ServiceContext> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const ctx = await loadServiceContext(user, SLUG);
  if (!ctx) throw new Error(`no membership for ${userId}`);
  return ctx;
}

async function addUser(owner: ServiceContext, roleKey: string, email: string, name: string, nameAr: string, extra: { clientId?: string; vendorId?: string; kind?: string; capacity?: number } = {}) {
  const userId = createId();
  await withTenant({ orgId: owner.orgId, userId: owner.userId }, async (tx) => {
    await tx.user.create({ data: { id: userId, email, name, nameAr, passwordHash: await hashPassword(PASSWORD), locale: "ar" } });
    const role = await tx.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: owner.orgId, key: roleKey } } });
    await tx.membership.create({ data: { organizationId: owner.orgId, userId, roleId: role.id, clientId: extra.clientId ?? null, vendorId: extra.vendorId ?? null } });
    if (extra.kind) await tx.resourceProfile.create({ data: { organizationId: owner.orgId, userId, kind: extra.kind, dailyCapacity: extra.capacity ?? 8, territories: extra.kind === "DRIVER" ? ["الرياض"] : [] } });
  });
  return { userId, ctx: await ctxFor(userId), email };
}

const tplId = (orgId: string, key: string) => withTenant({ orgId }, async (tx) => (await tx.template.findUniqueOrThrow({ where: { organizationId_key: { organizationId: orgId, key } } })).id);
const evidence = (ctx: ServiceContext, projectId: string, entityType: string, entityId: string, fileName = "evidence.png") =>
  withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => storeAttachment(tx, ctx, { projectId, entityType, entityId, kind: entityType === "DELIVERY" ? "EVIDENCE" : "FILE", fileName, declaredType: "image/png", body: PNG }));

async function main() {
  // Organizations are RLS-protected for the runtime role, so the owner's (global) login is the idempotency check.
  for (const domain of [DOMAIN, LEGACY_DOMAIN]) {
    if (await db.user.findUnique({ where: { email: `owner@${domain}` } })) {
      console.log(`Demo agency "${SLUG}" already exists — nothing to do. Sign in as owner@${domain}.`);
      return;
    }
  }
  const now = Date.now();
  console.log("Creating demo agency …");
  const reg = await registerAgency({ name: "نورة القحطاني (تجريبي)", email: `owner@${DOMAIN}`, password: PASSWORD, orgName: "وكالة الريادة للفعاليات (تجريبي)", orgSlug: SLUG, locale: "ar" });
  const owner = await ctxFor(reg.userId);

  const client = await saveClient(owner, { name: "مجموعة الأفق الوهمية القابضة", nameEn: "Horizon Holding (fictional)", sector: "استثمار", city: "الرياض" } as never);
  const venue = await saveVenue(owner, { name: "قاعة المؤتمرات الكبرى (تجريبي)", nameEn: "Grand Conference Hall (demo)", city: "الرياض", district: "العليا", capacity: 1200 } as never);

  const director = await addUser(owner, "ops_director", `director@${DOMAIN}`, "Fahad Alotaibi (demo)", "فهد العتيبي", { kind: "EMPLOYEE" });
  const pm = await addUser(owner, "project_manager", `pm@${DOMAIN}`, "Reem Alharbi (demo)", "ريم الحربي", { kind: "EMPLOYEE" });
  const lead = await addUser(owner, "team_lead", `lead@${DOMAIN}`, "Majed Alshehri (demo)", "ماجد الشهري", { kind: "EMPLOYEE" });
  const staff = await addUser(owner, "employee", `staff@${DOMAIN}`, "Lama Aldosari (demo)", "لمى الدوسري", { kind: "EMPLOYEE" });
  const agent1 = await addUser(owner, "field_agent", `agent1@${DOMAIN}`, "Turki Alanazi (demo)", "تركي العنزي", { kind: "DRIVER", capacity: 25 });
  const agent2 = await addUser(owner, "field_agent", `agent2@${DOMAIN}`, "Bader Almalki (demo)", "بدر المالكي", { kind: "DRIVER", capacity: 25 });
  const clientUser = await addUser(owner, "client_approver", `client@${DOMAIN}`, "Sara Alghamdi (demo)", "سارة الغامدي", { clientId: client.id });

  // ── Project 1: conference with VIP delivery, digital invitations and protocol ──
  console.log("Project 1: conference …");
  const eventAt = new Date(now + 18 * DAY);
  eventAt.setUTCHours(6, 0, 0, 0); // 09:00 Riyadh
  const { project: conf } = await createProject(pm.ctx, {
    name: "ملتقى مستقبل الضيافة ٢٠٢٦ (تجريبي)", nameEn: "Future of Hospitality Forum 2026 (demo)", description: "ملتقى سنوي تجريبي يجمع قادة قطاع الضيافة.", type: "CONFERENCE", priority: "HIGH", currency: "SAR", clientId: client.id, clientPortal: true,
    venueIds: [venue.id], eventStartAt: eventAt, eventEndAt: new Date(eventAt.getTime() + 9 * 3600_000), budgetAmount: 850000,
    templateIds: [await tplId(owner.orgId, "conference"), await tplId(owner.orgId, "vip-physical-delivery"), await tplId(owner.orgId, "vip-digital-campaign"), await tplId(owner.orgId, "vip-protocol")],
  } as never);
  for (const [u, role, flags] of [[director, "MEMBER", { canApprove: true, canViewVip: true, canViewFinance: true }], [lead, "LEAD", {}], [staff, "MEMBER", {}], [agent1, "FIELD_AGENT", {}], [agent2, "FIELD_AGENT", {}], [clientUser, "CLIENT_APPROVER", {}]] as const) {
    await upsertProjectMember(pm.ctx, { projectId: conf.id, userId: u.userId, role: role as never, canViewFinance: false, canViewVip: false, canExport: false, canApprove: false, workstreamIds: [], ...flags });
  }
  await setContractValue(owner, { projectId: conf.id, contractValue: 1150000 });

  // recipients through the real Import Studio (synthetic sample with deliberate problems)
  const file = path.join(process.cwd(), "samples/vip-recipients-ar.xlsx");
  const body = await readFile(file).catch(() => null);
  if (!body) throw new Error("samples/vip-recipients-ar.xlsx missing — run `pnpm samples` first");
  const batch = await createImport(pm.ctx, { projectId: conf.id, fileName: "vip-recipients-ar.xlsx", declaredType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body });
  await configureAndValidate(pm.ctx, { batchId: batch.id, sheetName: batch.sheetName!, headerRow: batch.headerRow, mapping: batch.mapping as Record<string, string | null>, options: { duplicateScope: "PROJECT", matchOn: ["mobile", "externalRef", "name"], requireMobile: true, requireLocation: true, defaultCity: "الرياض" } });
  await resolveRows(pm.ctx, { batchId: batch.id, scope: "ALL_DUPLICATES", resolution: "SKIP" });
  await resolveRows(pm.ctx, { batchId: batch.id, scope: "ALL_INVALID", resolution: "SKIP" });
  const physical = await withTenant({ orgId: owner.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: conf.id, type: "PHYSICAL" } }));
  await commitImport(pm.ctx, { batchId: batch.id, includeWarnings: true, acceptPartial: true, campaignId: physical.id });

  const deliveries = await withTenant({ orgId: owner.orgId }, (tx) => tx.delivery.findMany({ where: { projectId: conf.id }, orderBy: { createdAt: "asc" } }));
  console.log(`  ${deliveries.length} delivery cards from import`);
  const half = Math.ceil(deliveries.length / 2);
  await bulkAssign(pm.ctx, { projectId: conf.id, deliveryIds: deliveries.slice(0, half).map((d) => d.id), agentId: agent1.userId, overrideCapacity: true });
  await bulkAssign(pm.ctx, { projectId: conf.id, deliveryIds: deliveries.slice(half, deliveries.length - 4).map((d) => d.id), agentId: agent2.userId, overrideCapacity: true });
  // field progress: some delivered with evidence, a failed attempt, some out for delivery
  for (const [i, d] of deliveries.slice(0, 14).entries()) {
    const agent = i < half ? agent1 : agent2;
    await updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "OUT_FOR_DELIVERY", evidenceIds: [], source: "FIELD" });
    if (i < 10) {
      const att = await evidence(agent.ctx, conf.id, "DELIVERY", d.id);
      await updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "DELIVERED", receivedByName: "مدير المكتب (تجريبي)", receivedByRelation: "سكرتارية", evidenceIds: [att.id], source: "FIELD", lat: 24.7136, lng: 46.6753 });
    } else if (i === 10) {
      await updateDeliveryStatus(agent.ctx, { deliveryId: d.id, to: "FAILED_ATTEMPT", reason: "RECIPIENT_UNAVAILABLE", note: "المكتب مغلق — إعادة المحاولة غداً", evidenceIds: [], source: "FIELD" });
    }
  }

  // digital invitations: approval-gated, sent through the SIMULATION provider only
  const draft = await withTenant({ orgId: owner.orgId }, (tx) => tx.invitationCampaign.findFirstOrThrow({ where: { projectId: conf.id, type: "DIGITAL" } }));
  const recipients = await withTenant({ orgId: owner.orgId }, (tx) => tx.recipient.findMany({ where: { projectId: conf.id }, select: { id: true } }));
  const campaign = await saveDigitalCampaign(pm.ctx, { id: draft.id, projectId: conf.id, name: draft.name, channel: "SMS", bodyTemplate: "{{honorific}} {{name}}\nيسرنا دعوتكم لحضور {{event_name}} بتاريخ {{event_date}}.\nللتأكيد: {{rsvp_link}}", rsvpEnabled: true, qrEnabled: true });
  await addAudience(pm.ctx, { campaignId: campaign.id, recipientIds: recipients.map((r) => r.id) });
  const campaignApproval = await requestCampaignApproval(pm.ctx, campaign.id);
  await decideApproval(director.ctx, { approvalId: campaignApproval.id, decision: "APPROVED", comment: "معتمد — وضع المحاكاة" });
  await launchCampaign(pm.ctx, campaign.id);
  const jobs = await withTenant({ orgId: owner.orgId }, (tx) => tx.messageJob.findMany({ where: { invitation: { campaignId: campaign.id }, status: "SENT" }, take: 12 }));
  for (const [i, j] of jobs.entries()) {
    const token = /\/rsvp\/([A-Za-z0-9_-]+)/.exec(j.body)?.[1];
    if (token) await submitRsvp({ token, response: i % 4 === 3 ? "DECLINED" : "ATTENDING", guestsCount: 1 }, "127.0.0.1");
  }

  // event operations
  const event = await withTenant({ orgId: owner.orgId }, (tx) => tx.event.findFirstOrThrow({ where: { projectId: conf.id } }));
  const sp1 = await saveSpeaker(pm.ctx, { eventId: event.id, name: "د. خالد الزهراني (متحدث تجريبي)", title: "خبير الضيافة", topic: "مستقبل تجربة الضيف", status: "CONFIRMED" });
  const sp2 = await saveSpeaker(pm.ctx, { eventId: event.id, name: "أ. هند السبيعي (متحدثة تجريبية)", title: "مستشارة تحول رقمي", topic: "التقنية في الفعاليات", status: "MATERIALS_RECEIVED" });
  const t = (h: number, m = 0) => new Date(eventAt.getTime() + h * 3600_000 + m * 60_000);
  await saveSession(pm.ctx, { eventId: event.id, title: "الكلمة الافتتاحية", kind: "KEYNOTE", room: "القاعة الرئيسية", startsAt: t(0), endsAt: t(0, 30), speakerIds: [sp1.id], status: "CONFIRMED" });
  await saveSession(pm.ctx, { eventId: event.id, title: "جلسة حوارية: التقنية والضيافة", kind: "PANEL", room: "القاعة الرئيسية", startsAt: t(1), endsAt: t(2), speakerIds: [sp1.id, sp2.id], status: "PLANNED" });
  await saveSession(pm.ctx, { eventId: event.id, title: "استراحة وتواصل", kind: "BREAK", room: "البهو", startsAt: t(2), endsAt: t(2, 30), speakerIds: [], status: "PLANNED" });
  const cues = [];
  for (const [i, title] of ["فتح الأبواب واستقبال الضيوف", "عرض الفيلم الافتتاحي", "السلام الوطني", "الكلمة الافتتاحية"].entries()) cues.push(await saveRunItem(pm.ctx, { eventId: event.id, startsAt: t(-1 + i * 0.25), durationMin: 15, title, ownerId: lead.userId, location: "القاعة الرئيسية" }));
  await setRunItemStatus(pm.ctx, { id: cues[0].id, status: "STANDBY" });
  await saveShift(pm.ctx, { eventId: event.id, userId: staff.userId, role: "مكتب التسجيل", location: "المدخل الرئيسي", startsAt: t(-2), endsAt: t(6) });
  await saveShift(pm.ctx, { eventId: event.id, userId: lead.userId, role: "مشرف القاعة", location: "القاعة الرئيسية", startsAt: t(-2), endsAt: t(9) });
  const readiness = await withTenant({ orgId: owner.orgId }, (tx) => tx.readinessItem.findMany({ where: { eventId: event.id }, orderBy: { category: "asc" } }));
  for (const r of readiness.slice(0, 4)) await setReadinessStatus(pm.ctx, { id: r.id, status: "READY" });
  if (readiness[4]) await setReadinessStatus(pm.ctx, { id: readiness[4].id, status: "ISSUE", note: "تأخر توريد شاشات العرض — المورّد أكد التسليم خلال ٤٨ ساعة" });
  await reportIncident(lead.ctx, { projectId: conf.id, eventId: event.id, title: "تعطل مكيف القاعة الفرعية", severity: "MEDIUM", location: "القاعة B" });

  // protocol
  await importGuestsFromRecipients(pm.ctx, { projectId: conf.id, eventId: event.id });
  const front = await saveZone(pm.ctx, { eventId: event.id, name: "الصف الأول", capacity: 12, protocolLevel: 2 });
  await saveZone(pm.ctx, { eventId: event.id, name: "المنطقة العامة", capacity: 300 });
  const vips = await withTenant({ orgId: owner.orgId }, (tx) => tx.guest.findMany({ where: { projectId: conf.id, protocolLevel: { lte: 2 } }, take: 6 }));
  for (const [i, g] of vips.entries()) {
    await assignSeat(pm.ctx, { guestId: g.id, seatZoneId: front.id, seatLabel: `A${i + 1}` });
    if (i < 2) await setAttendance(pm.ctx, { guestId: g.id, attendance: "CONFIRMED" });
  }

  // client interaction
  await createChangeRequest(clientUser.ctx, { projectId: conf.id, title: "إضافة ركن إعلامي", description: "نرغب بإضافة ركن للمقابلات الإعلامية بجوار القاعة الرئيسية." });

  // ── Project 2: exhibition booth production with procurement and finance ──
  console.log("Project 2: booth production …");
  const { project: expo } = await createProject(pm.ctx, {
    name: "جناح مجموعة الأفق — معرض الابتكار (تجريبي)", nameEn: "Horizon booth — Innovation Expo (demo)", type: "EXHIBITION", priority: "CRITICAL", currency: "SAR", clientId: client.id, clientPortal: true,
    venueIds: [], eventStartAt: new Date(now + 35 * DAY), budgetAmount: 420000, templateIds: [await tplId(owner.orgId, "booth-production")],
  } as never);
  await upsertProjectMember(pm.ctx, { projectId: expo.id, userId: director.userId, role: "MEMBER", canViewFinance: true, canViewVip: false, canExport: true, canApprove: true, workstreamIds: [] });
  await upsertProjectMember(pm.ctx, { projectId: expo.id, userId: clientUser.userId, role: "CLIENT_APPROVER", canViewFinance: false, canViewVip: false, canExport: false, canApprove: false, workstreamIds: [] });
  await setContractValue(owner, { projectId: expo.id, contractValue: 560000 });
  const booth = await withTenant({ orgId: owner.orgId }, (tx) => tx.booth.findFirstOrThrow({ where: { projectId: expo.id } }));
  await saveBooth(pm.ctx, { id: booth.id, projectId: expo.id, name: booth.name, kind: "BOOTH", exhibition: "معرض الابتكار (تجريبي)", hall: "Hall 3", standNumber: "3-B12", widthM: 12, depthM: 8, heightM: 5, permitStatus: "SUBMITTED", brief: "جناح مفتوح من ثلاث جهات مع منطقة ضيافة ومسرح عروض صغير." });
  const rev = await createRevision(pm.ctx, { boothId: booth.id, title: "المفهوم الأولي", notes: "واجهة خشبية مع إضاءة خطية" });
  await evidence(pm.ctx, expo.id, "REVISION", rev.id, "concept-r1.png");
  const revApproval = await submitRevision(pm.ctx, { revisionId: rev.id, approverType: "INTERNAL" });
  await decideApproval(director.ctx, { approvalId: revApproval.id, decision: "APPROVED", comment: "معتمد للتنفيذ" });
  const boq = [["S-01", "هيكل الجناح والأرضيات", "STRUCTURE", "m2", 96, 450], ["L-01", "إضاءة خطية LED", "LIGHTING", "m", 60, 180], ["G-01", "جرافيك الواجهات", "GRAPHICS", "m2", 40, 120], ["F-01", "أثاث الضيافة", "FURNITURE", "set", 1, 18000], ["AV-01", "شاشة عرض 4×2 م", "AV", "unit", 1, 26000]] as const;
  for (const [code, description, category, unit, quantity, unitCost] of boq) await saveBoqItem(pm.ctx, { boothId: booth.id, code, description, category, unit, quantity, unitCost, committedCost: 0, actualCost: 0, status: "PLANNED" });
  await setBoothStage(pm.ctx, { boothId: booth.id, stage: "FABRICATION" });
  await saveSnag(pm.ctx, { boothId: booth.id, title: "اهتزاز في لوح الواجهة اليمنى", severity: "MEDIUM", location: "الواجهة الشرقية" });
  await recordInspection(pm.ctx, { boothId: booth.id, type: "STRUCTURAL", result: "CONDITIONAL", notes: "تثبيت إضافي مطلوب في الزاوية الشمالية" });

  const v1 = await saveVendor(owner, { name: "مصنع الأفق للمعارض (تجريبي)", category: "FABRICATION", vatNumber: "300000000000003", city: "الرياض", status: "PREFERRED" });
  const v2 = await saveVendor(owner, { name: "ورشة النخبة للديكور (تجريبي)", category: "FABRICATION", city: "جدة", status: "ACTIVE" });
  const v3 = await saveVendor(owner, { name: "شركة الضوء للصوتيات (تجريبي)", category: "AV", city: "الرياض", status: "ACTIVE" });
  const vendorUser = await addUser(owner, "vendor", `vendor@${DOMAIN}`, "Yazeed Alrashidi (demo)", "يزيد الرشيدي", { vendorId: v1.id });
  const rfq = await createRfq(pm.ctx, { projectId: expo.id, title: "تصنيع وتركيب هيكل الجناح", category: "FABRICATION", dueAt: new Date(now + 5 * DAY), vendorIds: [v1.id, v2.id] });
  const q1 = await recordQuote(pm.ctx, { projectId: expo.id, rfqId: rfq.id, vendorId: v1.id, amount: 96000, vatAmount: 14400, leadTimeDays: 12, reference: "Q-AF-118" });
  await recordQuote(pm.ctx, { projectId: expo.id, rfqId: rfq.id, vendorId: v2.id, amount: 88000, vatAmount: 13200, leadTimeDays: 25, reference: "N-2026-31" });
  const award = await awardQuote(pm.ctx, { quoteId: q1.id, budgetCategory: "PRODUCTION", justification: "مدة تنفيذ أقصر تناسب موعد المعرض" });
  await submitPurchaseOrder(pm.ctx, award.purchaseOrderId); // ≥ threshold → pending approval by a different finance approver
  await recordQuote(pm.ctx, { projectId: expo.id, vendorId: v3.id, amount: 24000, vatAmount: 3600, leadTimeDays: 7 });
  for (const [category, planned] of [["PRODUCTION", 250000], ["AV", 45000], ["LOGISTICS", 30000], ["STAFFING", 40000], ["CONTINGENCY", 25000]] as const) await saveBudget(pm.ctx, { projectId: expo.id, category, planned });
  const exp = await createExpense(pm.ctx, { projectId: expo.id, budgetCategory: "LOGISTICS", description: "نقل المواد إلى أرض المعرض", amount: 4800, vatAmount: 720, incurredAt: new Date(now - DAY) });
  await evidence(pm.ctx, expo.id, "EXPENSE", exp.id, "receipt.png");
  const expApproval = await requestExpenseApproval(pm.ctx, exp.id);
  await decideApproval(director.ctx, { approvalId: expApproval.id, decision: "APPROVED" });
  await createChangeOrder(pm.ctx, { projectId: expo.id, title: "إضافة شاشة تفاعلية", description: "طلب العميل شاشة لمس إضافية", amountDelta: 38000, costDelta: 24000, clientVisible: true });
  const wo = await createWorkOrder(pm.ctx, { projectId: expo.id, vendorId: v1.id, title: "تصنيع هيكل الجناح", scope: "حسب المراجعة R1 المعتمدة", dueAt: new Date(now + 14 * DAY) });
  await setWorkOrderStatus(vendorUser.ctx, { id: wo.id, status: "ACCEPTED" });
  await setWorkOrderStatus(vendorUser.ctx, { id: wo.id, status: "IN_PROGRESS" });

  // ── Project 3: a smaller corporate event, mostly planning ──
  await createProject(pm.ctx, { name: "حفل تكريم الشركاء (تجريبي)", type: "EVENT", priority: "MEDIUM", currency: "SAR", clientPortal: false, venueIds: [venue.id], eventStartAt: new Date(now + 50 * DAY), templateIds: [await tplId(owner.orgId, "corporate-event")] } as never);

  console.log("\nDemo agency ready (synthetic data only).");
  console.log(`  URL:       ${process.env.APP_URL ?? "http://localhost:3000"}/login`);
  console.log(`  Password:  ${PASSWORD}   (local demo only — set SEED_PASSWORD to change)`);
  for (const [who, email] of [["Agency owner", `owner@${DOMAIN}`], ["Ops director (finance/campaign approver)", `director@${DOMAIN}`], ["Project manager", `pm@${DOMAIN}`], ["Team lead", `lead@${DOMAIN}`], ["Employee", `staff@${DOMAIN}`], ["Field agent (mobile /field)", `agent1@${DOMAIN}`], ["Field agent 2", `agent2@${DOMAIN}`], ["Client approver (portal)", `client@${DOMAIN}`], ["Vendor (portal)", `vendor@${DOMAIN}`]]) console.log(`  ${who.padEnd(42)} ${email}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
