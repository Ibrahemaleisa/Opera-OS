import type { TaskDef, TemplateDefinition } from "./definition";

type TaskInput = Partial<Omit<TaskDef, "key" | "title" | "checklist" | "subtasks">> & {
  checklist?: [string, string][];
  subtasks?: [string, string, string][];
};

/** Compact task builder: t(key, ar, en, opts) */
function t(key: string, ar: string, en: string, o: TaskInput = {}): TaskDef {
  return {
    key,
    title: { ar, en },
    priority: o.priority ?? "MEDIUM",
    anchor: o.anchor ?? "start",
    offsetDays: o.offsetDays ?? 0,
    durationDays: o.durationDays ?? 1,
    estimateHours: o.estimateHours,
    slaHours: o.slaHours,
    requiresApproval: o.requiresApproval ?? false,
    clientVisible: o.clientVisible ?? false,
    defaultRole: o.defaultRole,
    checklist: (o.checklist ?? []).map(([a, e]) => ({ ar: a, en: e })),
    subtasks: (o.subtasks ?? []).map(([k, a, e]) => ({ key: k, title: { ar: a, en: e } })),
    dependsOn: o.dependsOn ?? [],
    tags: o.tags ?? [],
    description: o.description,
  };
}

export interface StarterTemplate {
  key: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  category: string;
  icon: string;
  definition: TemplateDefinition;
}

const vipDelivery: TemplateDefinition = {
  workstreams: [
    {
      key: "vip-delivery",
      name: { ar: "توصيل الدعوات الورقية لكبار الشخصيات", en: "VIP physical invitation delivery" },
      kind: "VIP_DELIVERY",
      color: "#64228A",
      tasks: [
        t("collect-list", "استلام قائمة المدعوين من العميل", "Receive guest list from client", { anchor: "event", offsetDays: -21, priority: "HIGH", clientVisible: true, defaultRole: "MANAGER", checklist: [["التحقق من اكتمال الأعمدة المطلوبة", "Check required columns are present"], ["تأكيد فئات كبار الشخصيات", "Confirm VIP tiers"]] }),
        t("import-validate", "استيراد القائمة والتحقق منها", "Import and validate list", { anchor: "event", offsetDays: -20, priority: "HIGH", dependsOn: ["collect-list"], estimateHours: 4, checklist: [["توحيد أرقام الجوال", "Normalize mobile numbers"], ["معالجة السجلات المكررة", "Resolve duplicates"], ["مراجعة العناوين الناقصة", "Review incomplete addresses"]] }),
        t("verify-contacts", "التحقق من بيانات التواصل", "Verify contact details", { anchor: "event", offsetDays: -18, dependsOn: ["import-validate"], estimateHours: 8 }),
        t("print-proof", "اعتماد بروفة طباعة الدعوة", "Approve invitation print proof", { anchor: "event", offsetDays: -17, requiresApproval: true, clientVisible: true, priority: "HIGH" }),
        t("print-pack", "طباعة وتغليف الدعوات", "Print and pack invitations", { anchor: "event", offsetDays: -14, durationDays: 3, dependsOn: ["print-proof"], subtasks: [["print", "طباعة", "Printing"], ["envelopes", "تجهيز الأظرف والملصقات", "Envelopes & labels"], ["qa", "فحص الجودة", "Quality check"]] }),
        t("plan-batches", "تقسيم الدفعات والمناطق", "Plan batches and territories", { anchor: "event", offsetDays: -12, dependsOn: ["verify-contacts"], defaultRole: "LEAD" }),
        t("brief-agents", "إحاطة المندوبين", "Brief delivery agents", { anchor: "event", offsetDays: -11, dependsOn: ["plan-batches"], checklist: [["آداب التعامل مع كبار الشخصيات", "VIP etiquette"], ["إجراءات إثبات التسليم", "Proof-of-delivery procedure"], ["سرية البيانات", "Data confidentiality"]] }),
        t("dispatch", "تنفيذ التوصيل", "Execute deliveries", { anchor: "event", offsetDays: -10, durationDays: 7, dependsOn: ["brief-agents", "print-pack"], priority: "CRITICAL", tags: ["field"] }),
        t("failed-followup", "متابعة المحاولات الفاشلة", "Follow up failed attempts", { anchor: "event", offsetDays: -4, durationDays: 2, dependsOn: ["dispatch"] }),
        t("delivery-report", "تقرير التوصيل النهائي للعميل", "Final delivery report to client", { anchor: "event", offsetDays: -2, dependsOn: ["failed-followup"], clientVisible: true }),
      ],
    },
  ],
  milestones: [
    { key: "list-locked", title: { ar: "اعتماد قائمة المدعوين", en: "Guest list locked" }, anchor: "event", offsetDays: -18, clientVisible: true, workstream: "vip-delivery" },
    { key: "dispatch-start", title: { ar: "بدء التوصيل", en: "Delivery starts" }, anchor: "event", offsetDays: -10, clientVisible: true, workstream: "vip-delivery" },
    { key: "delivery-complete", title: { ar: "اكتمال التوصيل", en: "Deliveries complete" }, anchor: "event", offsetDays: -3, clientVisible: true, workstream: "vip-delivery" },
  ],
  deliverables: [{ key: "delivery-report", title: { ar: "تقرير إثبات التسليم", en: "Proof-of-delivery report" }, requiresApproval: false, clientVisible: true, workstream: "vip-delivery", anchor: "event", offsetDays: -2 }],
  customFields: [{ entityType: "RECIPIENT", key: "seatPreference", labelAr: "تفضيل المقعد", labelEn: "Seat preference", fieldType: "TEXT", options: [], required: false }],
  records: [{ type: "PHYSICAL_CAMPAIGN", name: { ar: "حملة الدعوات الورقية", en: "Physical invitation campaign" }, workstream: "vip-delivery" }],
  budget: [{ category: "PRINTING", share: 0.4 }, { category: "DELIVERY", share: 0.6 }],
  dashboards: ["delivery"],
  automations: ["delivery-failed-followup", "delivery-completed-progress"],
  roles: [{ role: "MANAGER", label: { ar: "مدير التوصيل", en: "Delivery manager" } }, { role: "FIELD_AGENT", label: { ar: "مندوب", en: "Delivery agent" } }],
};

const digital: TemplateDefinition = {
  workstreams: [
    {
      key: "digital-invites",
      name: { ar: "الدعوات الرقمية", en: "Digital invitations" },
      kind: "DIGITAL_INVITES",
      color: "#2F6F8F",
      tasks: [
        t("guest-list", "تجهيز قائمة المستلمين", "Prepare recipient list", { anchor: "event", offsetDays: -21, priority: "HIGH" }),
        t("design", "تصميم الدعوة الرقمية", "Design digital invitation", { anchor: "event", offsetDays: -20, durationDays: 4, estimateHours: 12 }),
        t("copy-approval", "اعتماد النص والتصميم", "Approve copy and design", { anchor: "event", offsetDays: -15, requiresApproval: true, clientVisible: true, dependsOn: ["design"] }),
        t("channel-setup", "تهيئة قنوات الإرسال الرسمية", "Configure official sending channels", { anchor: "event", offsetDays: -15, checklist: [["اسم المرسل للرسائل النصية", "SMS sender ID"], ["قالب واتساب المعتمد", "Approved WhatsApp template"], ["نطاق البريد (SPF/DKIM)", "Email domain (SPF/DKIM)"]] }),
        t("test-send", "إرسال تجريبي داخلي", "Internal test send", { anchor: "event", offsetDays: -13, dependsOn: ["copy-approval", "channel-setup"] }),
        t("campaign-approval", "اعتماد الإرسال الجماعي", "Bulk send approval", { anchor: "event", offsetDays: -12, requiresApproval: true, dependsOn: ["test-send", "guest-list"], priority: "HIGH" }),
        t("send", "إرسال الحملة", "Send campaign", { anchor: "event", offsetDays: -12, dependsOn: ["campaign-approval"] }),
        t("rsvp-followup", "متابعة الردود والتذكير", "RSVP follow-up & reminders", { anchor: "event", offsetDays: -7, durationDays: 5, dependsOn: ["send"] }),
        t("final-list", "قائمة الحضور النهائية", "Final attendance list", { anchor: "event", offsetDays: -2, clientVisible: true, dependsOn: ["rsvp-followup"] }),
      ],
    },
  ],
  milestones: [{ key: "campaign-sent", title: { ar: "إرسال الدعوات", en: "Invitations sent" }, anchor: "event", offsetDays: -12, clientVisible: true, workstream: "digital-invites" }],
  deliverables: [{ key: "rsvp-report", title: { ar: "تقرير تأكيد الحضور", en: "RSVP report" }, clientVisible: true, requiresApproval: false, workstream: "digital-invites", anchor: "event", offsetDays: -2 }],
  customFields: [],
  records: [{ type: "DIGITAL_CAMPAIGN", name: { ar: "حملة الدعوات الرقمية", en: "Digital invitation campaign" }, workstream: "digital-invites" }],
  budget: [],
  dashboards: ["rsvp"],
  automations: ["campaign-approval-notify"],
  roles: [],
};

const eventOpsTasks = (prefix: string) => [
  t(`${prefix}brief`, "اعتماد موجز الفعالية", "Approve event brief", { anchor: "event", offsetDays: -45, requiresApproval: true, clientVisible: true, priority: "HIGH", defaultRole: "MANAGER" }),
  t(`${prefix}venue`, "حجز القاعة وتأكيد المخطط", "Book venue and confirm layout", { anchor: "event", offsetDays: -40, dependsOn: [`${prefix}brief`] }),
  t(`${prefix}suppliers`, "التعاقد مع الموردين", "Contract suppliers", { anchor: "event", offsetDays: -30, durationDays: 7, dependsOn: [`${prefix}venue`], subtasks: [[`${prefix}av`, "الصوت والإضاءة", "AV & lighting"], [`${prefix}catering`, "الضيافة", "Catering"], [`${prefix}security`, "الأمن", "Security"]] }),
  t(`${prefix}run-of-show`, "إعداد البرنامج التشغيلي", "Prepare run-of-show", { anchor: "event", offsetDays: -14, dependsOn: [`${prefix}suppliers`], clientVisible: true, requiresApproval: true }),
  t(`${prefix}staffing`, "جدولة الكوادر والمناوبات", "Schedule staff & shifts", { anchor: "event", offsetDays: -10 }),
  t(`${prefix}readiness`, "مراجعة الجاهزية", "Readiness review", { anchor: "event", offsetDays: -2, priority: "HIGH", dependsOn: [`${prefix}run-of-show`, `${prefix}staffing`], checklist: [["الصوتيات تعمل", "AV tested"], ["مسارات الدخول جاهزة", "Entry routes ready"], ["فريق المراسم في موقعه", "Protocol team in position"], ["خطة الطوارئ موزعة", "Emergency plan distributed"]] }),
  t(`${prefix}rehearsal`, "البروفة العامة", "Full rehearsal", { anchor: "event", offsetDays: -1, dependsOn: [`${prefix}readiness`] }),
  t(`${prefix}live`, "تشغيل يوم الفعالية", "Event-day operations", { anchor: "event", offsetDays: 0, priority: "CRITICAL", dependsOn: [`${prefix}rehearsal`] }),
  t(`${prefix}teardown`, "التفكيك والإخلاء", "Teardown & venue release", { anchor: "event", offsetDays: 1, dependsOn: [`${prefix}live`] }),
  t(`${prefix}report`, "تقرير ما بعد الفعالية", "Post-event report", { anchor: "event", offsetDays: 5, clientVisible: true, dependsOn: [`${prefix}live`] }),
];

const corporateEvent: TemplateDefinition = {
  workstreams: [{ key: "event-ops", name: { ar: "تشغيل الفعالية", en: "Event operations" }, kind: "EVENT_OPS", color: "#B98A2E", tasks: eventOpsTasks("") }],
  milestones: [
    { key: "brief-approved", title: { ar: "اعتماد الموجز", en: "Brief approved" }, anchor: "event", offsetDays: -45, clientVisible: true },
    { key: "event-day", title: { ar: "يوم الفعالية", en: "Event day" }, anchor: "event", offsetDays: 0, clientVisible: true },
  ],
  deliverables: [{ key: "post-event", title: { ar: "تقرير ما بعد الفعالية", en: "Post-event report" }, clientVisible: true, requiresApproval: true, anchor: "event", offsetDays: 5 }],
  customFields: [],
  records: [{ type: "EVENT", name: { ar: "الفعالية", en: "Event" }, workstream: "event-ops" }],
  budget: [{ category: "VENUE", share: 0.3 }, { category: "AV", share: 0.2 }, { category: "HOSPITALITY", share: 0.25 }, { category: "STAFFING", share: 0.15 }, { category: "CONTINGENCY", share: 0.1 }],
  dashboards: ["readiness"],
  automations: ["event-approaching-readiness"],
  roles: [],
};

const conference: TemplateDefinition = {
  workstreams: [
    {
      key: "conference-ops",
      name: { ar: "عمليات المؤتمر", en: "Conference operations" },
      kind: "CONFERENCE",
      color: "#3C1862",
      tasks: [
        t("agenda", "إعداد الأجندة والجلسات", "Build agenda & sessions", { anchor: "event", offsetDays: -50, clientVisible: true, requiresApproval: true, priority: "HIGH" }),
        t("speakers", "دعوة المتحدثين وتأكيدهم", "Invite and confirm speakers", { anchor: "event", offsetDays: -45, durationDays: 14, dependsOn: ["agenda"] }),
        t("speaker-materials", "استلام عروض المتحدثين", "Collect speaker materials", { anchor: "event", offsetDays: -10, dependsOn: ["speakers"] }),
        t("registration", "فتح التسجيل وإدارة الحضور", "Open registration", { anchor: "event", offsetDays: -30 }),
        t("room-plan", "تخطيط القاعات والجلسات المتوازية", "Room & parallel-track planning", { anchor: "event", offsetDays: -25, dependsOn: ["agenda"] }),
        t("badges", "طباعة البطاقات", "Print badges", { anchor: "event", offsetDays: -4, dependsOn: ["registration"] }),
        t("speaker-brief", "إحاطة المتحدثين ومديري الجلسات", "Brief speakers & moderators", { anchor: "event", offsetDays: -1, dependsOn: ["speaker-materials"] }),
      ],
    },
    { key: "event-ops", name: { ar: "تشغيل الفعالية", en: "Event operations" }, kind: "EVENT_OPS", color: "#B98A2E", tasks: eventOpsTasks("ops-") },
  ],
  milestones: [
    { key: "agenda-final", title: { ar: "اعتماد الأجندة النهائية", en: "Final agenda approved" }, anchor: "event", offsetDays: -20, clientVisible: true, workstream: "conference-ops" },
    { key: "conference-day", title: { ar: "انعقاد المؤتمر", en: "Conference day" }, anchor: "event", offsetDays: 0, clientVisible: true },
  ],
  deliverables: [
    { key: "agenda-doc", title: { ar: "الأجندة المعتمدة", en: "Approved agenda" }, requiresApproval: true, clientVisible: true, workstream: "conference-ops", anchor: "event", offsetDays: -20 },
    { key: "post-report", title: { ar: "تقرير المؤتمر", en: "Conference report" }, requiresApproval: true, clientVisible: true, anchor: "event", offsetDays: 7 },
  ],
  customFields: [{ entityType: "PROJECT", key: "expectedAttendees", labelAr: "عدد الحضور المتوقع", labelEn: "Expected attendees", fieldType: "NUMBER", options: [], required: false }],
  records: [{ type: "EVENT", name: { ar: "المؤتمر", en: "Conference" }, workstream: "conference-ops" }],
  budget: [{ category: "VENUE", share: 0.3 }, { category: "AV", share: 0.2 }, { category: "HOSPITALITY", share: 0.2 }, { category: "PRINTING", share: 0.1 }, { category: "STAFFING", share: 0.1 }, { category: "CONTINGENCY", share: 0.1 }],
  dashboards: ["readiness"],
  automations: ["event-approaching-readiness"],
  roles: [],
};

const protocol: TemplateDefinition = {
  workstreams: [
    {
      key: "protocol",
      name: { ar: "المراسم واستقبال كبار الشخصيات", en: "VIP protocol" },
      kind: "PROTOCOL",
      color: "#9A6BC4",
      tasks: [
        t("vip-list", "اعتماد قائمة كبار الشخصيات وتصنيفهم", "Approve VIP list & classifications", { anchor: "event", offsetDays: -21, requiresApproval: true, priority: "HIGH" }),
        t("seating", "إعداد مخطط الجلوس حسب الأسبقية", "Seating plan by precedence", { anchor: "event", offsetDays: -10, dependsOn: ["vip-list"], requiresApproval: true, clientVisible: true }),
        t("escorts", "تكليف المرافقين", "Assign escorts", { anchor: "event", offsetDays: -7, dependsOn: ["vip-list"] }),
        t("transport", "تنسيق النقل والاستقبال", "Coordinate transport & reception", { anchor: "event", offsetDays: -5, dependsOn: ["escorts"] }),
        t("checkpoints", "تجهيز نقاط الاستقبال", "Prepare reception checkpoints", { anchor: "event", offsetDays: -2, checklist: [["لوحات الإرشاد", "Wayfinding signage"], ["قوائم الاستقبال المطبوعة", "Printed reception lists"], ["قنوات الاتصال اللاسلكي", "Radio channels"]] }),
        t("protocol-rehearsal", "بروفة المراسم", "Protocol rehearsal", { anchor: "event", offsetDays: -1, dependsOn: ["seating", "transport", "checkpoints"], priority: "HIGH" }),
        t("live-protocol", "تنفيذ المراسم يوم الفعالية", "Event-day protocol", { anchor: "event", offsetDays: 0, priority: "CRITICAL", dependsOn: ["protocol-rehearsal"] }),
      ],
    },
  ],
  milestones: [{ key: "seating-approved", title: { ar: "اعتماد مخطط الجلوس", en: "Seating plan approved" }, anchor: "event", offsetDays: -8, clientVisible: true, workstream: "protocol" }],
  deliverables: [],
  customFields: [],
  records: [{ type: "GUEST_LIST", name: { ar: "قائمة المراسم", en: "Protocol guest list" }, workstream: "protocol" }],
  budget: [],
  dashboards: ["protocol"],
  automations: [],
  roles: [],
};

const boothTasks = (prefix: string, pavilion = false) => [
  t(`${prefix}brief`, "استلام موجز العميل والمتطلبات", "Receive client brief & requirements", { anchor: "start", offsetDays: 0, priority: "HIGH", clientVisible: true }),
  t(`${prefix}concept`, "تطوير المفاهيم التصميمية", "Develop design concepts", { anchor: "start", offsetDays: 2, durationDays: 7, dependsOn: [`${prefix}brief`], estimateHours: 40 }),
  t(`${prefix}design-approval`, "اعتماد التصميم من العميل", "Client design approval", { anchor: "start", offsetDays: 10, requiresApproval: true, clientVisible: true, dependsOn: [`${prefix}concept`], priority: "HIGH" }),
  t(`${prefix}drawings`, "المخططات التنفيذية والمواصفات", "Shop drawings & specifications", { anchor: "start", offsetDays: 12, durationDays: 5, dependsOn: [`${prefix}design-approval`] }),
  t(`${prefix}boq`, "جدول الكميات", "Bill of quantities", { anchor: "start", offsetDays: 14, dependsOn: [`${prefix}drawings`] }),
  t(`${prefix}rfq`, "طلبات عروض الأسعار من الموردين", "Vendor RFQs & quotations", { anchor: "start", offsetDays: 15, durationDays: 4, dependsOn: [`${prefix}boq`] }),
  t(`${prefix}permits`, "تصاريح الموقع والمنظم", "Site & organizer permits", { anchor: "event", offsetDays: -20, checklist: [["اعتماد المخططات من المنظم", "Organizer drawing approval"], ["شهادة السلامة الإنشائية", "Structural safety certificate"], ["تصاريح الدخول للعمالة", "Labor access passes"]] }),
  t(`${prefix}fabrication`, "التصنيع في الورشة", "Workshop fabrication", { anchor: "event", offsetDays: -18, durationDays: 12, dependsOn: [`${prefix}rfq`], priority: "HIGH" }),
  t(`${prefix}logistics`, "النقل والشحن للموقع", "Transport to site", { anchor: "event", offsetDays: -5, dependsOn: [`${prefix}fabrication`] }),
  t(`${prefix}installation`, "التركيب في الموقع", "On-site installation", { anchor: "event", offsetDays: -4, durationDays: pavilion ? 4 : 3, dependsOn: [`${prefix}logistics`, `${prefix}permits`], priority: "CRITICAL" }),
  t(`${prefix}inspection`, "الفحص وقائمة الملاحظات", "Inspection & snag list", { anchor: "event", offsetDays: -1, dependsOn: [`${prefix}installation`] }),
  t(`${prefix}handover`, "التسليم والتوقيع", "Handover sign-off", { anchor: "event", offsetDays: -1, requiresApproval: true, clientVisible: true, dependsOn: [`${prefix}inspection`] }),
  t(`${prefix}dismantle`, "الفك والإخلاء", "Dismantling", { anchor: "deadline", offsetDays: 1, durationDays: 2 }),
  t(`${prefix}closeout`, "الإقفال وتسوية التكاليف", "Closeout & cost reconciliation", { anchor: "deadline", offsetDays: 5, dependsOn: [`${prefix}dismantle`] }),
];

const boothStatuses = [
  { key: "todo", ar: "للتنفيذ", en: "To do", category: "TODO" as const },
  { key: "design", ar: "تصميم", en: "Design", category: "ACTIVE" as const },
  { key: "client_review", ar: "مراجعة العميل", en: "Client review", category: "REVIEW" as const },
  { key: "production", ar: "إنتاج", en: "Production", category: "ACTIVE" as const },
  { key: "blocked", ar: "محجوب", en: "Blocked", category: "BLOCKED" as const },
  { key: "done", ar: "منجز", en: "Done", category: "DONE" as const },
];

const booth: TemplateDefinition = {
  workstreams: [{ key: "booth", name: { ar: "إنتاج الجناح", en: "Booth production" }, kind: "BOOTH", color: "#5E5470", statuses: boothStatuses, tasks: boothTasks("") }],
  milestones: [
    { key: "design-approved", title: { ar: "اعتماد التصميم", en: "Design approved" }, anchor: "start", offsetDays: 10, clientVisible: true, workstream: "booth" },
    { key: "build-start", title: { ar: "بدء التركيب", en: "Build starts" }, anchor: "event", offsetDays: -4, clientVisible: true, workstream: "booth" },
    { key: "handover", title: { ar: "تسليم الجناح", en: "Booth handover" }, anchor: "event", offsetDays: -1, clientVisible: true, workstream: "booth" },
  ],
  deliverables: [
    { key: "final-design", title: { ar: "التصميم النهائي المعتمد", en: "Approved final design" }, requiresApproval: true, clientVisible: true, workstream: "booth", anchor: "start", offsetDays: 10 },
    { key: "handover-cert", title: { ar: "محضر التسليم", en: "Handover certificate" }, requiresApproval: true, clientVisible: true, workstream: "booth", anchor: "event", offsetDays: -1 },
  ],
  customFields: [],
  records: [{ type: "BOOTH", name: { ar: "الجناح", en: "Booth" }, workstream: "booth" }],
  budget: [{ category: "PRODUCTION", share: 0.65 }, { category: "LOGISTICS", share: 0.15 }, { category: "AV", share: 0.1 }, { category: "CONTINGENCY", share: 0.1 }],
  dashboards: ["production", "budget"],
  automations: ["approval-rejected-reopen"],
  roles: [],
};

const pavilion: TemplateDefinition = {
  workstreams: [{ key: "pavilion", name: { ar: "إنتاج البافيليون", en: "Pavilion production" }, kind: "PAVILION", color: "#5E5470", statuses: boothStatuses, tasks: boothTasks("pv-", true) }],
  milestones: booth.milestones.map((m) => ({ ...m, workstream: "pavilion" })),
  deliverables: booth.deliverables.map((d) => ({ ...d, workstream: "pavilion" })),
  customFields: [],
  records: [{ type: "PAVILION", name: { ar: "البافيليون", en: "Pavilion" }, workstream: "pavilion" }],
  budget: booth.budget,
  dashboards: ["production", "budget"],
  automations: ["approval-rejected-reopen"],
  roles: [],
};

const exhibition: TemplateDefinition = {
  workstreams: [
    {
      key: "exhibition",
      name: { ar: "تنظيم المعرض", en: "Exhibition management" },
      kind: "EVENT_OPS",
      color: "#B98A2E",
      tasks: [
        t("floorplan", "اعتماد مخطط أرض المعرض", "Approve exhibition floorplan", { anchor: "event", offsetDays: -60, requiresApproval: true, clientVisible: true }),
        t("exhibitor-sales", "بيع المساحات للعارضين", "Exhibitor space sales", { anchor: "event", offsetDays: -55, durationDays: 30, dependsOn: ["floorplan"] }),
        t("exhibitor-manual", "دليل العارضين", "Exhibitor manual", { anchor: "event", offsetDays: -40 }),
        t("contractor-approvals", "اعتماد مقاولي الأجنحة", "Approve stand contractors", { anchor: "event", offsetDays: -20, dependsOn: ["exhibitor-manual"] }),
        t("build-up", "فترة التركيب", "Build-up period", { anchor: "event", offsetDays: -3, durationDays: 3, priority: "HIGH", dependsOn: ["contractor-approvals"] }),
        t("show-days", "أيام المعرض", "Show days", { anchor: "event", offsetDays: 0, durationDays: 3, priority: "CRITICAL", dependsOn: ["build-up"] }),
        t("breakdown", "فترة الفك", "Breakdown period", { anchor: "deadline", offsetDays: 1, durationDays: 2 }),
      ],
    },
  ],
  milestones: [{ key: "opening", title: { ar: "افتتاح المعرض", en: "Exhibition opening" }, anchor: "event", offsetDays: 0, clientVisible: true }],
  deliverables: [],
  customFields: [],
  records: [{ type: "EVENT", name: { ar: "المعرض", en: "Exhibition" }, workstream: "exhibition" }],
  budget: [{ category: "VENUE", share: 0.5 }, { category: "PRODUCTION", share: 0.3 }, { category: "CONTINGENCY", share: 0.2 }],
  dashboards: ["readiness"],
  automations: [],
  roles: [],
};

const blank: TemplateDefinition = {
  workstreams: [{ key: "general", name: { ar: "عام", en: "General" }, kind: "GENERAL", tasks: [] }],
  milestones: [],
  deliverables: [],
  customFields: [],
  records: [],
  budget: [],
  dashboards: [],
  automations: [],
  roles: [],
};

export const STARTER_TEMPLATES: StarterTemplate[] = [
  { key: "vip-physical-delivery", nameAr: "توصيل الدعوات الورقية لكبار الشخصيات", nameEn: "VIP Physical Invitation Delivery", descriptionAr: "استيراد المدعوين، الطباعة، التوزيع الميداني وإثبات التسليم.", descriptionEn: "Recipient import, printing, field dispatch and proof of delivery.", category: "INVITATIONS", icon: "package", definition: vipDelivery },
  { key: "vip-digital-campaign", nameAr: "حملة الدعوات الرقمية لكبار الشخصيات", nameEn: "VIP Digital Invitation Campaign", descriptionAr: "تصميم، اعتماد، إرسال عبر القنوات الرسمية وتتبع الردود.", descriptionEn: "Design, approval, official-channel sending and RSVP tracking.", category: "INVITATIONS", icon: "send", definition: digital },
  { key: "corporate-event", nameAr: "فعالية مؤسسية", nameEn: "Corporate Event", descriptionAr: "من الموجز إلى التشغيل وتقرير ما بعد الفعالية.", descriptionEn: "From brief to live operations and post-event report.", category: "EVENTS", icon: "calendar", definition: corporateEvent },
  { key: "conference", nameAr: "مؤتمر", nameEn: "Conference", descriptionAr: "الأجندة، المتحدثون، التسجيل، القاعات والتشغيل.", descriptionEn: "Agenda, speakers, registration, rooms and operations.", category: "EVENTS", icon: "mic", definition: conference },
  { key: "exhibition", nameAr: "معرض", nameEn: "Exhibition", descriptionAr: "مخطط الأرض، العارضون، التركيب وأيام العرض.", descriptionEn: "Floorplan, exhibitors, build-up and show days.", category: "EVENTS", icon: "layout", definition: exhibition },
  { key: "vip-protocol", nameAr: "مراسم كبار الشخصيات", nameEn: "VIP Protocol", descriptionAr: "التصنيف، الجلوس، المرافقون، النقل ونقاط الاستقبال.", descriptionEn: "Classification, seating, escorts, transport and checkpoints.", category: "PROTOCOL", icon: "crown", definition: protocol },
  { key: "booth-production", nameAr: "إنتاج جناح معرض", nameEn: "Booth Production", descriptionAr: "التصميم، الاعتمادات، جدول الكميات، التصنيع والتسليم.", descriptionEn: "Design, approvals, BOQ, fabrication and handover.", category: "PRODUCTION", icon: "hammer", definition: booth },
  { key: "pavilion-production", nameAr: "إنتاج بافيليون", nameEn: "Pavilion Production", descriptionAr: "إنتاج الأجنحة الوطنية والبافيليونات الكبيرة.", descriptionEn: "National pavilions and large-format builds.", category: "PRODUCTION", icon: "landmark", definition: pavilion },
  { key: "custom-blank", nameAr: "مشروع مخصص فارغ", nameEn: "Custom Blank Project", descriptionAr: "ابدأ من الصفر بمسار عمل عام.", descriptionEn: "Start from scratch with one general workstream.", category: "GENERAL", icon: "square", definition: blank },
];
