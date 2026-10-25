# Opera — experience contract

How Opera must feel and behave. Engineers build to it and QA checks against it. Owner: Product
Architect (Agent 1).

**Sources.** The founder's direction; the experience audits (product, design, systems, UI
engineering); the orchestrator's decisions for this milestone.

**Relation to other docs.**
* `BUSINESS_RULES.md` keeps governing the foundations: lifecycle, handover, approvals, security, recovery.
* Nothing here weakens tenant isolation, authorization, approval safety, the delivery state machine, import validation, campaign scheduling or health calculations. See §8 for the guard list.

**IDs** (tests cite them): `E-` principles · `S-` suggestion contract · `I-` intelligence ·
`W1-`/`W2-`/`W4-`/`W5-` WOW moments · `F1`–`F10` friction fixes · `B-` defaults.

**Measurements marked "before"** come from the product walkthrough of 2026-10-25. That was an
internal Playwright walkthrough, not user research. Scripts are in the experience scratchpad.

---

## 1. The five principles as checkable rules

### Instant clarity: where am I, what matters, what next
| ID | Rule | Check |
|---|---|---|
| E-1 | Every screen has one title, one line of context and **at most one primary (violet) action**. Row actions are quiet | Count `variant=default` buttons per screen ≤ 1 (dialogs count separately) |
| E-2 | **Every number is a doorway.** It carries its window or denominator ("11 overdue", "4 of 7 ready", "in 18 days") and links to the list behind it. The count equals that list's length | Every count is built from `operations/criteria.ts` (or the module's own selector); a test asserts count = list length |
| E-3 | **No raw text leaks.** No enum keys (`todo`, `PENDING`), template keys (`conference v1`), audit action keys, i18n keys, `…` placeholders, or English inside the Arabic UI or the reverse (codes such as PRJ-2026-001 and proper nouns excepted) | Smoke test renders every page in AR and EN and fails on `/\b[a-z]+[._][a-z_.]+\b/` outside `<code>`/ids and on known enum values |
| E-4 | **No contradictory or false state.** Never "all normal" while any signal is unknown. Never "sent" for a simulated message. Never "awaiting decision" on something that has no pending decision. A destructive dialog's dismiss label never reuses its destructive verb | Copy review list in §5 (F10); unit test on System health state |
| E-5 | **Each role lands on its own question**: owner/director/PM → Operations; lead/employee/freelancer → My work; field agent → field app; client → portal; vendor → vendor portal | Login redirect test per role |

### Intelligent assistance: anticipate from real context
| ID | Rule | Check |
|---|---|---|
| E-6 | **Nothing fabricated.** Every value shown is stored or computed from stored facts. Unknown is shown as unknown ("dates pending: set the event date"). No date, owner, count, risk or forecast is invented | W1-3; code review: no `now + N days` default anchors |
| E-7 | Every suggestion follows the suggestion contract (§2); every derived judgement shows its reasons (health, threat, priority) in the user's language | §2 tests; reason-dictionary test (S-11) |
| E-8 | No language model in this milestone; all intelligence is deterministic and explainable | Dependency review |

### Minimal friction: no unnecessary steps, repeated inputs or confusing decisions
| ID | Rule | Check |
|---|---|---|
| E-9 | **Ask only what is needed now.** Creation forms show required fields plus suggested ones; everything else sits under "More" or becomes a Gap prompt later. Visible inputs: project create 3 questions, task create 3 fields, invite 2 fields | Field count per dialog (F4, F8) |
| E-10 | **Fix it where you see it.** An exception or My-work row's action (assign, take, acknowledge, re-plan, decide) runs in place through the existing server action. Navigation happens only when the action needs another context | W2-4; interaction count |
| E-11 | **Never ask for what the system knows**: the agency slug; the PM as default owner of manager steps; the only campaign of a project; a default city from the venue | F6; W1-4 |
| E-12 | **Consequences before commitment.** Destructive or multi-record changes show a preview with counts (lifecycle, reschedule, handover, bulk assign > 1) and are confirmed once | W4, W5; existing lifecycle dialog |

### Exceptional craftsmanship
| ID | Rule | Check |
|---|---|---|
| E-13 | Motion: opacity and translate only, ≤ 300 ms, ease-out; `prefers-reduced-motion` removes movement; no animation delays content | CSS/token review; reduced-motion E2E |
| E-14 | Arabic and English at 1440 px and 390 px: no horizontal overflow; dates bidi-isolated; Arabic-Indic digits accepted in every number field | Existing overflow sweep extended to new screens |
| E-15 | Every mutation shows a pending state and a result. A failure keeps the user's input (M1). No artificial loading hold | `useAction` / ActionButton usage; E2E on failure |
| E-16 | A brand grammar, used the same everywhere. **Fact**: solid (ink, filled Ring/Dot). **Suggestion**: dashed `--suggest` outline, hollow ring and "مقترح / Suggested". **Missing**: Gap mark with words. **Sequence and time**: Line | Visual review against BRAND.md |

### Progressive power: simple by default, sophisticated when needed
| ID | Rule | Check |
|---|---|---|
| E-17 | Modules appear in navigation when the organisation uses them (data-aware). Every route stays reachable through ⌘K and Settings | Nav test: new agency vs demo agency |
| E-18 | Hiding never removes a capability or a check. Permissions are enforced server-side, unchanged | Scope tests stay green |
| E-19 | Advanced options are collapsed by default and remembered per user only for convenience | UI review |

---

## 2. The suggestion contract

| ID | Rule |
|---|---|
| S-1 | **Computed on read, never stored.** A scoped loader reads only through `projectScope`, `taskVisibilityWhere`, `activityWhere` and `can()`. A pure function computes the suggestion. No job writes suggestions |
| S-2 | **Shape**: `{ id, kind, subject {entityType, entityId, projectId, version}, proposal, action, confidence: "strong" \| "likely", reasons: ReasonCode[], consequential }`. `id` = hash of kind + subject + input digest (stable while the inputs are unchanged). **No percentages, no scores shown** |
| S-3 | **Labelled**: rendered only through the `Suggestion` / `SuggestedValue` / `UseAll` primitives (dashed outline, hollow ring, "مقترح / Suggested"). A suggestion never fills a field silently. *Defaults* (values the user sees in a form before saving) are not suggestions and are shown as normal values |
| S-4 | **Explained**: one visible reason line (the first reason) plus "Why?" listing all reasons. Reasons are built from the loader's own output; the explainer makes no extra queries |
| S-5 | **One gesture to accept**: "استخدام / Use" (or Enter on focus); "استخدام الكل / Use all" for a list. Accepting calls **the same server action and service function as the manual edit**, with `proposal` as its input. Authorization, archived checks, approval gates and the CAS `version` check run unchanged. There is no suggestion-specific write path |
| S-6 | **Stale**: if the subject's `version` changed, the normal conflict is returned, the suggestion is recomputed and the user sees the fresh one. Bulk accept reports skipped rows (CE rule 5) |
| S-7 | **Audited on accept**: the normal audit event plus `meta.origin = { suggestion: kind, id, reasons: [codes] }`. Ignored or dismissed suggestions are not audited |
| S-8 | **Dismissed**: "ليس الآن / Not now", remembered per user, per session (client-side, keyed by `id`). A materially changed situation (new `id`) may show again |
| S-9 | **Consequential = preview, then confirm.** These are: notifying others or clients; changing client-visible data; changing more than one record; removing a safeguard (dependency, approval gate); touching finance or VIP records; sending messages. Accepting such a suggestion opens the existing confirm step; it never executes directly. Approval decisions and sends are **never** offered as an accept button |
| S-10 | **Scope safety**, per §2.8 of the systems audit: the tenant is always isolated (no cross-org signals). Freelancers and task-scoped users get suggestions about their own tasks only, never owner suggestions or other people's load. Workstream-restricted members see candidates and predecessors from their workstreams; outside items appear as counts ("1 task outside your view"). The portal, vendors and field agents get none. VIP fields never appear in a suggestion (recipient gaps are counts). Finance reasons only with `scope.finance`. **Cross-project signals (load, past ownership) are counts or bands, never names or titles**, and only for callers with project-wide `operate` + `task.assign` |
| S-11 | **Reason copy**: every `ReasonCode` has an AR and EN string; a unit test fails on a missing one |
| S-12 | **Honest silence**: when the signal is too weak (owner score < 3, no anchor date, no history), show no suggestion rather than a guess |
| S-13 | **Tests**: one scope-matrix integration test per kind (owner, director, PM, workstream member, freelancer, client, vendor, field agent) that serialises the output and asserts no foreign ids, titles or names; plus a "same path" test that accepting a suggestion the caller may not perform is refused by the normal action |

---

## 3. Intelligence catalogue (this milestone)

Copy uses `{param}` placeholders. "Shown" and "hidden" apply in addition to S-10 and S-12.

### I-1 Owner suggestion (`kind: "owner"`)
**Signal.**
* Template `defaultRole` (`Task.templateKey` → definition via `Workstream.templateInstanceId`).
* Workstream fit (`ProjectMember.workstreamIds`; tasks owned in the same workstream).
* Past ownership of the same template step (DONE tasks with that `templateKey`, last 365 days; index `Task(organizationId, templateKey)`).
* Load in the task's window: due ± 3 days; estimate hours and shifts vs `ResourceProfile.dailyCapacity`; cancelled tasks and archived projects excluded.

**Candidates.** Active members passing `assertAssignable`.

**Score.** templateRole +3; workstreamMember +3 / workstreamOwner +2; pastOwner +2 (1–2) / +3 (≥ 3); busy −1; overCapacity −2. Confidence is "strong" when the top score is ≥ 5 and leads by ≥ 2; otherwise "likely". Below 3: no suggestion.

| Code | EN | AR |
|---|---|---|
| `templateRole` | The template gives this step to the {role} | القالب يُسند هذه الخطوة إلى {role} |
| `namedPm` | Project manager | مدير المشروع |
| `workstreamMember` | Works on {workstream} | يعمل على مسار {workstream} |
| `workstreamOwner` | Owns {n} tasks in this workstream | مسؤول عن {n} مهام في هذا المسار |
| `pastOwner` | Did this step in {n} earlier projects | نفّذ هذه الخطوة في {n} مشاريع سابقة |
| `available` | Free that week | متاح في ذلك الأسبوع |
| `busy` | Busy that week | مشغول في ذلك الأسبوع |
| `overCapacity` | Over capacity that week | فوق طاقته في ذلك الأسبوع |

**Shown**: unowned open tasks — inline assign, task create, distribute (I-8). **Hidden**: for freelancer, workstream-restricted, client, vendor and field scopes; for archived projects. **Accept**: `updateTask` / `bulkUpdateTasks` (with versions).

### I-2 Due-date suggestion (`kind: "due"`)
**Signal.** The parent's `dueAt`; the dependency's due + 1 working day; `Project.eventStartAt` (fallback `deadline`) for relative chips. Working week Sun–Thu: a weekend date moves to the previous working day.

| Code | EN | AR |
|---|---|---|
| `parent` | Same as the parent task | موعد المهمة الأم نفسه |
| `dependency` | The working day after #{number} | يوم العمل التالي لـ #{number} |
| `eventRelative` | {n} days before the event | قبل الفعالية بـ {n} أيام |
| `eventDay` | Event day | يوم الفعالية |
| `offWeekend` | Moved off the weekend | نُقل من عطلة نهاية الأسبوع |

**Shown**: task create and edit, as chips. **Hidden**: event chips when the project has no anchor date. Instead show the Gap: "Set the event date to plan backwards / حدّد موعد الفعالية للتخطيط بالعكس". **Accept**: the form value (a default, saved by the normal save).

### I-3 Missing information (`kind: "gap"`)
**Signal.** Facts about absence (exact), each tied to the project type or templates so it is not noise. `severity` is `blocker` or `gap`. Each gap has one fix link.

| Code | Shown when | EN | AR |
|---|---|---|---|
| `anchorDate` | no `eventStartAt` and no `deadline` | No event date — tasks can't be scheduled | لا يوجد موعد للفعالية — لا يمكن جدولة المهام |
| `placeholderDates` | template applied without an anchor | Dates pending for {n} tasks | {n} مهام بانتظار تحديد المواعيد |
| `eventDateMismatch` | `Event.startsAt` ≠ `Project.eventStartAt` | The event and the project have different dates | تاريخ الفعالية يختلف عن تاريخ المشروع |
| `client` | no `clientId` (non-internal types) | No client yet | لم يُحدَّد العميل بعد |
| `venue` | event/conference/exhibition types without `ProjectVenue` | No venue yet | لم يُحدَّد الموقع بعد |
| `manager` | no active PM | No project manager | لا يوجد مدير للمشروع |
| `team` | only one internal member | Only you on this project | أنت وحدك في هذا المشروع |
| `unownedSoon` | open tasks with no owner, due ≤ 7 days | {n} tasks due this week have no owner | {n} مهام مستحقة هذا الأسبوع بلا مسؤول |
| `undatedMilestones` | milestones with no `dueDate` | {n} milestones without a date | {n} مراحل بلا تاريخ |
| `noReadiness` | event ≤ 14 days, no readiness items | No readiness checklist for {event} | لا توجد قائمة جاهزية لـ {event} |
| `recipientsNoAddress` | PHYSICAL campaign; recipients without address/maps/geo | {n} guests have no address | {n} مدعوين بلا عنوان |
| `recipientsNoMobile` | recipients without `mobile` | {n} guests have no mobile number | {n} مدعوين بلا رقم جوال |
| `campaignNoAudience` | DIGITAL campaign with 0 invitations | {campaign} has no recipients | {campaign} بلا مستلمين |
| `campaignUnscheduled` | DIGITAL draft or approved, not scheduled, event ≤ 14 days | {campaign} isn't scheduled | {campaign} غير مجدولة |
| `rsvpAfterEvent` | `rsvpDeadline` > event start | RSVP closes after the event starts | يُغلق تأكيد الحضور بعد بدء الفعالية |
| `noApprover` | approval-gated work with no eligible approver | Nobody can approve {n} items yet | لا أحد يستطيع اعتماد {n} عناصر بعد |

**Shown**: the project overview header ("{n} things missing / {n} أمور ناقصة"), portfolio rows, and "Needs you" for PMs. **Hidden**: recipient gaps without VIP scope show counts only. Client, vendor and field scopes see none. **Accept**: the fix link or field (a normal edit).

### I-4 Prioritisation of My work (`kind: "priority"`)
**Signal.** Within a time bucket only (overdue · today · this week · later; never reordered across buckets):
* priority weight;
* client-visible (+1);
* number of open dependents (`TaskDependency`, max +3);
* event in ≤ 7 days (+2);
* `escalationLevel`.

Waiting items (blocked, awaiting approval) go to "Waiting", never to the top.

| Code | EN | AR |
|---|---|---|
| `overdueBy` | Overdue by {n} days | متأخرة {n} أيام |
| `blocksOthers` | Blocks {n} tasks | تُعطّل {n} مهام |
| `eventSoon` | Event in {n} days | الفعالية بعد {n} أيام |
| `clientVisible` | The client sees this | يراها العميل |
| `escalated` | Escalated to {role} | صُعِّدت إلى {role} |
| `approvalNotRequested` | Needs approval — not requested yet | تحتاج اعتماداً ولم يُطلب بعد |

**Shown**: a "why first" chip (top reason) on each My-work row. The order is a fact of the ranking, not a suggestion to accept. **Hidden**: when no reason applies.

### I-5 Blocked-task resolution (`kind: "resolveBlocked"`)
**Signal.** The open predecessors visible to the caller:
* their owner and its membership status;
* `dueAt`;
* staleness (last update or audit);
* a pending approval;
* `TaskAssignmentHistory.reason = "handover"`.

Hidden predecessors appear as a count.

| Resolution | Consequential | Reason code | EN | AR |
|---|---|---|---|---|
| Assign the predecessor (I-1) | no | `predecessorUnowned` | #{number} has no owner | #{number} بلا مسؤول |
| Remind the owner (dedupe `nudge:<taskId>:<day>`) | no | `predecessorLate` | #{number} is {n} days late | #{number} متأخرة {n} أيام |
| Remind the owner | no | `predecessorStale` | No update on #{number} for {n} days | لا تحديث على #{number} منذ {n} أيام |
| Chase the approval | no | `predecessorAwaitingApproval` | #{number} is waiting for approval | #{number} بانتظار الاعتماد |
| Reassign | no | `predecessorOwnerInactive` | #{number}'s owner has left | مسؤول #{number} لم يعد في الفريق |
| Start without it (remove dependency) | **yes** | `removeDependency` | Remove the link to #{number} | إزالة الارتباط بـ #{number} |
| Move my due date (W4-style preview of my dependents) | **yes** | `reschedule` | Move my date and see what follows | نقل موعدي ومعاينة ما يتأثر |
| — | — | `hiddenPredecessor` | Waiting on {n} task(s) outside your view (owner notified) | بانتظار {n} مهام خارج صلاحيتك (أُبلغ المسؤول) |

**Shown**: on blocked tasks (task detail, My work "Waiting", W2 folded rows). **Accept**: the existing actions (`updateTask`, notify, `removeDependency` with confirm).

### I-6 What changed since you were last here (`kind: "changes"`)
**Signal.** `AuditEvent` per project since `since`.
* `since` is stored per device per project; the server clamps it to 14 days.
* Scoped by `activityWhere`, plus visible task ids for task-scoped and workstream-restricted callers.
* The caller's own actions are excluded.
* Changes are collapsed per entity to the net change; "changed and reverted" is said as such.
* Rendered through `describeAudit`.

Classes: `assignedToMe`, `myDueMoved`, `done`, `blocked`, `approvalDecided`, `incident`, `deliverableDecided`, `lifecycle`.

Header EN: "{n} changes since {when}: {done} done · {blocked} blocked · {moved} dates moved". Header AR: "{n} تغييرات منذ {when}: {done} منجزة · {blocked} معطّلة · {moved} مواعيد تغيّرت".

**Shown**: the project overview and My work, when n ≥ 1. **Hidden**: first visit (no `since`), clients, vendors, field agents. This is information, not a suggestion; it has nothing to accept.

### I-7 Threats to the next event (`kind: "threat"`)
**Signal.**
* Health v2 reasons plus event-scoped risks.
* Root causes from the dependency graph: the late head of a chain counts once, with its waiting dependents.
* Counts from the shared criteria.
* Ranking: blockers first, then by time-to-impact. **Max 5 lines per event.**

| Code | EN | AR | Action |
|---|---|---|---|
| `lateChain` | #{number} is {n} days late and holds up {m} tasks | #{number} متأخرة {n} أيام وتُعطّل {m} مهام | Assign / Remind |
| `unownedBeforeEvent` | {n} tasks before the event have no owner | {n} مهام قبل الفعالية بلا مسؤول | Distribute (I-8) |
| `overdueClientVisible` | {n} overdue items the client can see | {n} عناصر متأخرة يراها العميل | Open |
| `readinessLow` | Readiness {ready} of {total} | الجاهزية {ready} من {total} | Prepare |
| `deliveriesNotOut` | {n} invitations not out; deadline in {h} hours | {n} دعوات لم تخرج؛ الموعد بعد {h} ساعة | Dispatch |
| `clientApprovalsPending` | {n} client approvals past due | {n} اعتمادات لدى العميل تجاوزت موعدها | Chase |
| `campaignUnscheduled` | Digital invitations aren't scheduled | الدعوات الرقمية غير مجدولة | Open |
| `incidentOpen` | {severity} incident open for {duration} | بلاغ {severity} مفتوح منذ {duration} | Acknowledge |
| `overContract` *(finance scope)* | Planned cost exceeds the contract | التكلفة المخططة تتجاوز العقد | Open finance |

Header EN: "{n} things threaten {date}". Header AR: "{n} أمور تهدّد {date}". When there are none and **every signal was computed**: "Nothing threatens {event} today / لا شيء يهدّد {event} اليوم". **Shown**: Operations "Next events" and the project overview, for events in ≤ 30 days. **Hidden**: finance lines without finance scope; VIP details are never shown.

### I-8 Workload distribution (`kind: "distribute"`)
**Signal.** I-1 per task, plus the receiver's resulting load (open tasks and hours in the window vs capacity). For handover it also uses the handover eligibility rules: `mayDecide` for approvals; `project.manage` for the manager role; field-agent rules; shift clash.

| Code | EN | AR |
|---|---|---|
| (I-1 codes) | | |
| `resultingLoad` | {n} open tasks after this | {n} مهام مفتوحة بعد ذلك |
| `wouldExceed` | Would be over capacity | سيتجاوز طاقته |
| `eligibleApprover` | Can decide this approval | يستطيع اتخاذ قرار هذا الاعتماد |

**Shown**: "Distribute unowned work" from the project, a workstream or the Operations home; the handover dialog (suggested replacement per category). **Hidden**: for callers without project-wide `operate` + `task.assign`. **Accept**: `bulkUpdateTasks` (with versions) / the handover service. Consequential (more than one record), so a preview is shown and confirmed once.

### I-9 Date-change consequence preview (`kind: "reschedule"`)
**Signal.**
* Old and new anchors.
* Template offsets (`anchor`, `offsetDays`, `durationDays`) via `TemplateInstance` + `Task.templateKey`.
* Dependencies.
* Campaign `scheduledAt` / `deliveryDeadline` / `rsvpDeadline`.
* `Event`, `Booth.handoverAt` / `siteAccessAt`, deliveries, shifts.

**Algorithm.** Pure (systems audit §1.8). An item "follows the template" when its date equals the template date for the old anchor (± 1 min).

| Class / code | EN | AR |
|---|---|---|
| `followsTemplate` (moves) | Follows the plan: {n} days before the event | يتبع الخطة: قبل الفعالية بـ {n} أيام |
| `editedByHand` (kept) | Edited by hand — stays | عُدّل يدوياً — يبقى كما هو |
| `alreadyHappening` (untouched) | Already done or under way | منجز أو قيد التنفيذ |
| `wouldBeOverdue` (impossible) | Would be overdue the moment you save | سيصبح متأخراً فور الحفظ |
| `breaksDependency` (impossible) | Would be due before #{number} | سيستحق قبل #{number} |
| `campaignAfterEvent` (impossible) | Send time would fall after the event | موعد الإرسال سيقع بعد الفعالية |
| `handoverBeforeAccess` (impossible) | Handover would be before site access | التسليم سيسبق دخول الموقع |
| `sendTimeApproved` (needs decision) | Approved send time — changing it needs re-approval | موعد الإرسال معتمد — تغييره يتطلب إعادة اعتماد |
| `unsure` (kept) | Can't tell if this follows the plan — stays | لا يمكن التأكد من ارتباطه بالخطة — يبقى |

**Shown**: whenever the event date, deadline or start date changes, and for a "dates pending" project when its anchor is first set. **Accept**: one confirm (W4).

---

## 4. WOW moments

### W1 — An event in 30 days → a ready plan in about a minute (X1)
**Before.** Measured on a new agency:
* 4 wizard screens and 6 steps;
* 14 fields shown before any template;
* templates on screen 3; event date optional;
* result for a conference 30 days out: 27 tasks, **25 unowned**, **4 overdue at creation**, health "Watch 54", **15 exceptions** on the Operations home 2 minutes after sign-up;
* sign-up needed a manual Latin slug for an Arabic agency name.

| ID | Acceptance criterion (after) |
|---|---|
| W1-1 | Project creation is **one screen** with three questions: *what* (type chips preselecting template bundles, editable), *when* (event date), *for whom* (client combobox with inline create). Other fields are absent from creation and appear later as Gap prompts on the project |
| W1-2 | From an empty agency, creating the first project takes **≤ 3 interactions** after typing (choose what, set the date, Create). The name is prefilled from template + client + month and is editable |
| W1-3 | **No invented dates.** Without an anchor date, template tasks, milestones and deliverables are created **undated**. No Event, campaign deadline or booth handover gets an invented date. The project shows "Dates pending — set the event date" (I-3 `placeholderDates`). Health counts no overdue for them |
| W1-4 | **Owner defaults** (defaults, not suggestions): template steps for the manager role go to the **named PM**, else the creator. In an agency with exactly one internal active member, every template step defaults to that member, labelled "You, until you invite your team / أنت، حتى تدعو فريقك". With a team, creation ends with an offer "Assign {n} suggested owners" (I-8) |
| W1-5 | **Fit to time.** When the lead time is shorter than the template needs, the preview shows a suggestion: "{n} tasks need more time than you have — compress them into {d} days?" (Use / Keep). Use: no open task is due before today, and dependency order is kept. Keep: the overdue count is shown **before** Create |
| W1-6 | **The live preview equals the result**: workstreams, task and milestone counts and the today → event Line in the preview match what is created (the same function in dry-run) |
| W1-7 | After Create with "Use", the new project raises **0 overdue exceptions** on the Operations home |
| W1-8 | Registration asks for name, e-mail, password and agency name only. The slug is generated (renamable in Settings); **4 inputs**, before 5 |
| W1-9 | Tests: no-invented-dates (W1-3); compression keeps order and has no past due dates (W1-5); preview = result (W1-6); owner defaults (W1-4) |

### W2 — What threatens the next event, at a glance (X2)
**Before.** Demo, director:
* the Operations home showed **50 exceptions, 117 buttons and links, 2,671 px tall**;
* the same root cause repeated across "late", "waiting on a late task" and "unowned soon";
* every row action navigated away;
* board payload 230 KB and 69–72 SQL statements at 25 projects.

| ID | Acceptance criterion (after) |
|---|---|
| W2-1 | Each event in ≤ 30 days shows a **threat brief** (I-7): a one-sentence header and **≤ 5 ranked lines**, blockers first, each with **one inline action** |
| W2-2 | **Root-cause folding**: a task waiting on a late task folds under the late head (`lateChain`); unowned tasks fold per project and workstream. On demo PRJ-001 the brief accounts for **≥ 90 %** of the board's exceptions: every folded exception maps to exactly one brief line |
| W2-3 | Every count in the brief equals the length of the list it opens (shared criteria) |
| W2-4 | Inline actions run in place through the existing actions: **assign** (with I-1 suggestions), **acknowledge** an incident, **remind**, and **decide** (approve, or reject with its mandatory comment). No navigation for these |
| W2-5 | Budget on the demo director's home at 1440 px: **≤ 60 buttons/links** (before 117) and **≤ 1,800 px tall** (before 2,671). `operationsBoard` ≤ 50 SQL statements and ≤ 60 KB payload at 25 projects |
| W2-6 | "Nothing threatens {event} today" appears only when every signal was computed; any unknown signal shows as unknown (E-4) |
| W2-7 | Scope: finance lines only with finance scope; no VIP data; freelancers and workstream-restricted members see only their visible work (S-10) |
| W2-8 | My work: rows ordered by I-4 with a "why first" chip; "Take it" on unowned tasks in the member's workstreams (F5); "what changed" (I-6) at the top when n ≥ 1 |

### W3 — Import → deliveries moving (deferred)
Deferred to a later phase. The Import Studio, validation and dispatch stay as they are in this milestone.
Only F9's copy and state fix applies.

### W4 — Move the event date and see the consequences first (X1)
**Before.** Changing `eventStartAt` changed only the project row (`projects/service.ts updateProject`). Tasks, milestones, deliverables, campaign deadlines, the Event and booth handover kept their old dates, and nothing warned the user.

| ID | Acceptance criterion (after) |
|---|---|
| W4-1 | Changing the event date, deadline or start date (project, or the primary event) opens a **preview before anything is saved**. Two choices: "Shift dates / نقل المواعيد" (primary) and "Change the date only / تغيير التاريخ فقط" |
| W4-2 | The preview groups items as **moves · kept (edited by hand) · already happening · impossible · needs a decision · unsure**, with counts and the I-9 reason per item, laid out on the project Line |
| W4-3 | Items that follow the template move by exactly Δ (weekend-adjusted, Sun–Thu). Hand-edited items stay and are listed. DONE and CANCELLED items, sending or sent campaigns, LIVE events and delivered or in-car deliveries are untouched |
| W4-4 | An approved campaign whose send time would change is listed under "needs a decision" with `sendTimeApproved`. Confirming supersedes that approval (existing binding rule) and the preview says so beforehand |
| W4-5 | Client-visible milestones and deliverables are listed separately. "Tell the client" is an explicit choice, **off** by default |
| W4-6 | **Preview = apply**: apply takes the project `version`, the preview digest and per-row versions in one transaction. If anything changed since the preview, nothing is applied and the preview refreshes |
| W4-7 | Audit: one `project.reschedule` (Δ and counts) plus `task.update` per moved task with `meta.cause = "reschedule"`. Each affected owner gets **one** notification |
| W4-8 | A "dates pending" project (W1-3): setting the anchor offers "Schedule {n} tasks from the event date" through the same preview |
| W4-9 | Demo check: move PRJ-001 +7 days; the database diff equals the preview exactly. Unit tests for every I-9 class |
| W4-10 | Needs `scope.manage`. Shows no finance or recipient data (delivery counts only) |

### W5 — Distribute or hand over a workload in one pass (X2)
**Before.**
* Demo PRJ-001 had **42 unowned tasks**, and the home offered one "Assign" link per row (each a navigation, about 3 interactions per task).
* The new agency had 25 unowned.
* The handover dialog (M2) offered no suggested replacements.

| ID | Acceptance criterion (after) |
|---|---|
| W5-1 | "Distribute unowned work / توزيع المهام بلا مسؤول" opens from a project, a workstream, or the threat brief (`unownedBeforeEvent`). Rows are grouped by workstream, each with an I-1 suggestion and its reason. "Use all" fills every row that has a suggestion |
| W5-2 | Each receiver shows the resulting load (Ring) before confirming. Rows that would put someone over capacity are flagged (`wouldExceed`) and **excluded from "Use all"** unless chosen one by one |
| W5-3 | Confirm applies through `bulkUpdateTasks` with per-row versions. Skipped rows are reported. History reason `bulk`; audit `meta.origin` (S-7) |
| W5-4 | Demo PRJ-001: all 42 unowned tasks are assigned in **≤ 3 interactions** (open, Use all, Confirm), given eligible candidates exist |
| W5-5 | The handover dialog shows a suggested replacement per category (I-8). Every suggestion passes the handover eligibility rules (approvals: `mayDecide`; manager: `project.manage`; field rules; shift clash). The last-manager rule and the explicit "Leave unowned" stay. BUSINESS_RULES HO-1…HO-9 stay green |
| W5-6 | Hidden from callers without project-wide `operate` + `task.assign`; cross-project load appears as bands, never project names (S-10) |

---

## 5. Friction fixes F1–F10

| ID | Fix | Acceptance check |
|---|---|---|
| F1 | A new project is not born late, unowned or red (W1-3, W1-4, W1-5, W1-7) | A new conference 30 days out with "Use": 0 overdue, manager steps owned, 0 overdue exceptions |
| F2 | The Operations home is a briefing grouped by root cause (W2-1, W2-2) | Demo: ≤ 5 lines per event cover ≥ 90 % of the exceptions |
| F3 | Act where the problem is shown (W2-4, E-10) | Assign, acknowledge, remind and decide complete without navigation |
| F4 | One-screen project creation (W1-1, W1-2) | ≤ 3 questions visible; ≤ 3 interactions after typing |
| F5 | Employees can take unowned work: "Take it / سأتولاها" in My work for tasks in their workstreams (task.manage; never freelancers) | A staff member sees unowned tasks in their workstreams and takes one in 1 click; history shows it |
| F6 | Automatic agency slug at registration (W1-8) | An Arabic agency name registers with 4 inputs |
| F7 | Navigation ≤ 8 items, role- and data-aware; settings grouped; project tabs 5–7 plus "More"; notifications in the bell | A new agency's sidebar ≤ 8; every route reachable via ⌘K and Settings; the demo still shows all its used modules |
| F8 | Lean task forms: create shows title, owner and due (owner and due may carry suggestions); the rest under "More"; estimate in hours; **SLA removed from the UI** | Task create shows 3 fields; no "SLA" anywhere in the UI |
| F9 | Import keeps its flow; the post-commit state shows the result immediately (no stale "Ready to commit" behind a success toast) | After commit the page shows the committed counts without a reload |
| F10 | Copy and state fixes: cancel dialog ("Keep project / الإبقاء على المشروع" to dismiss; one close control; "A director can reopen it later; cancelled items stay cancelled"); milestone PENDING = "Not started / لم تبدأ"; System health never "all normal" while a check is unknown; no raw keys (E-3) | Copy review + the E-3 smoke test |

---

## 6. Bureaucracy defaults (hidden or relaxed, as decided)

| ID | Default | Why |
|---|---|---|
| B-1 | **Progressive navigation**: a module appears once the organisation has data or a project that uses it. Every route is reachable via ⌘K and Settings. Permissions are unchanged | A new agency sees what it uses, not 22 items |
| B-2 | **Settings grouped**: Organisation (General, Security, Approvals) · People · Directory (Clients, Venues, Custom fields) · Operations (Templates, Automation, Messaging) · System (Audit, System health). Advanced options collapsed | Clarity; the tabs grew to 10 |
| B-3 | **Small-team self-approval** is offered to an owner **at the moment a request is refused**: "Nobody else can approve this. Let owners approve their own requests? / لا يوجد من يعتمد هذا غيرك. هل تسمح للمالكين باعتماد طلباتهم؟". The settings toggle remains. **No mandatory expiry or caps.** A per-decision note is kept, audited and shown to the other owners. Client approvals and independent-approval projects are never eligible. Requester ≠ approver stays the default | Small agencies get unblocked at the moment it matters, not through a policy screen |
| B-4 | **MFA grace for a new organisation starts when a second member joins or guest data is first imported.** MFA is still required for privileged roles; a solo founder isn't nagged on day one | Security where there is something to protect |
| B-5 | **Independent-approval toggle** and the **STRICT approval policy** live under Advanced (project and organisation), visible to directors and owners only. Defaults: off / STANDARD | Governance for those who need it, invisible to others |
| B-6 | **Task SLA hours** removed from the UI (never enforced). Estimate in hours. Recurrence, tags, client-visible and requires-approval under "More" (requires-approval defaults from the template) | Fewer internals on everyday forms |
| B-7 | **System health** sits under Settings → System. It never says "normal" while a signal is unknown. *(Decided: owners and directors see one calm line on Operations only when a signal is **critical**; warnings stay on the health page.)* | Not a page a small agency needs to visit |
| B-8 | **Notifications** live in the header bell; the full page is reachable from it | One less nav item |
| B-9 | *(Decided)* **Portfolio views**: List, Timeline and Calendar (event dates matter to event teams); the status Board is removed now that status is a lifecycle, not a workflow | Four parallel views didn't earn their place |

---

## 7. Not in this milestone
* Language-model features of any kind (what-changed prose, header mapping fallback, copy drafting, brief-to-tasks).
* **W3**: import → suggested dispatch by district, value-pattern mapping, mapping skip. Phase 2 if time allows.
* Vendor-side features (vendor quotes, vendor suggestions).
* Multi-day calendar views.
* Dependency suggestions for manual tasks.
* Server-side dismissal storage (`SuggestionDismissal`) and a server-side "last seen" (`ProjectVisit`). Both are client-side in this milestone.
* Suggestions in the client portal, vendor portal or field app.

Further simplifications proposed in the product audit that await an owner decision (unchanged foundations until then):
* reasons required only for cancel, close override, reopen and client-visible date moves;
* close gates presented as one checklist with only three hard blocks;
* second- and third-tier escalations folded into the daily digest;
* no organisation-level data-residency UI.

---

## 8. Guard list (must stay green)
Tenant isolation · authorization (`projectScope` NotFound, `taskVisibilityWhere`, `activityWhere`) ·
one definition per signal (`operations/criteria.ts`, `computeHealthV2`) · approval safety
(`mayDecide`, `resolveApproverSet`, one PENDING per entity, approval-gated completion) · CAS
concurrency · lifecycle preview/execution parity · delivery state machine · import validation ·
campaign scheduling and approval binding · audit in the same transaction · M1/M2 security fixes.
The test files are listed in the systems audit §6. New tests are named with their IDs from this document.
