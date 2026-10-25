# Opera — business rules (Milestone 2)

The rules the implementers build to and QA tests against. Owner: Agent 1 (Chief Product Architect).
Scope: Milestone 2 completes the operational decision loop **Trigger → Assign → Notify → Decide →
Execute → Verify → Escalate → Close**. The owner's decisions (2026-10-25) are binding and are cited
as **[D1]–[D5]**. Acceptance criteria carry IDs (`LC-1`, `HO-3`, …) so tests can cite them.
"MUST/NEVER" are hard rules; anything not stated here keeps its Milestone 1 behaviour.

---

## 0. Conventions

| Term | Meaning |
|---|---|
| **Owner** | member whose role has `baseRole = OWNER` |
| **Director** | `baseRole = OPS_DIRECTOR`. Wherever a rule says "directors", the fallback is owners when there is no active director |
| **PM** | an *active* project member with project role `MANAGER` |
| **Admin** | a holder of `org.members.manage` (owner, director) |
| **Active member** | `Membership.status = ACTIVE`. Inactive people are never recipients, approvers or owners of new work |
| **Archived project** | status `CLOSED` or `CANCELLED` (`archivedAt` set) |
| **Quiet project** | `ON_HOLD`, `COMPLETED`, `CLOSED` or `CANCELLED`. Reminders and escalations are suppressed, with the exceptions in §1.6 |
| **Reason** | free text, 10–1000 characters, trimmed; stored in the audit row (and in `Project.statusReason` for project status) |
| **Time** | stored in UTC; displayed and scheduled in Asia/Riyadh. Timers are **calendar hours**: events run on weekends |
| **Scheduler tick** | `schedulerTick()`. Production MUST run it **at least every 5 minutes** (worker or external cron). See §7.4 |
| **Notice** | an in-app `Notification` row, optionally with an e-mail `NotificationDelivery` (§3) |

Constants, in one place. Implement them as named constants or org settings, with these defaults:

| Constant | Default | Where |
|---|---|---|
| `APPROVAL_SLA_HOURS` | 48 (org setting, 4–168) | §3.4, §4 |
| `APPROVAL_REMINDER_BEFORE_DUE_H` | 24 (sent only when the SLA is ≥ 36 h) | §3.4 |
| Task ladder | L1 at due · L2 at due + 24 h · L3 at due + 72 h | §3.4 |
| Work-order ladder | L1 at due · L2 at due + 24 h · L3 at due + 72 h · "not accepted" reminder at issue + 48 h | §3.4 |
| Incident acknowledge windows | CRITICAL 15 min / 60 min · HIGH 60 min · MEDIUM 4 h · LOW none | §3.4 |
| Delivery deadline ladder | deadline − 48 h · deadline − 24 h · deadline passed | §3.4 |
| E-mail retries | 5 attempts, backoff 1 m, 5 m, 30 m, 2 h, 6 h → DEAD | §3.3 |
| Daily digest | 07:30 Asia/Riyadh, every day | §3.2 |
| Import lease | 120 s, renewed at least every 60 s; max 3 attempts | §7.1 |
| Campaign dispatch lease | 120 s, renewed per batch of ≤ 200 messages; max 5 attempts | §7.2 |
| Late scheduled send window | 30 min | §7.2 |
| Password-reset token | 30 min, single use | §5.1 |
| MFA challenge | 5 min, single use, 5 wrong codes | §5.2 |
| MFA grace | 14 days | §5.2 |
| Portal visibility after archive | 180 days | §1.5 |

---

## 1. Project lifecycle

**Problem.** Project status was a free-form label. Cancelling or closing left tasks, sends,
deliveries, POs and reminders running, and archived projects stayed editable (F-22).
**Owner role.** PM for day-to-day transitions. Directors and owners (`project.delete`) for cancel,
close and reopen.

### 1.1 Statuses (existing enum, no new statuses)

| Status | Meaning now | Operational? | Client portal label |
|---|---|---|---|
| `DRAFT` | proposal or tentative, not committed | quiet; nothing is sent or dispatched | not visible |
| `PLANNING` | committed, preparing | yes | "Planning" |
| `ACTIVE` | executing | yes | "In progress" |
| `ON_HOLD` | paused by decision | quiet, with new operations blocked (§1.6) | "On hold" (no reason shown) |
| `AT_RISK` | **legacy, no longer settable.** "At risk" is derived by health v2 (`ProjectHealth.atRisk`) | — | never shown |
| `COMPLETED` | delivered; **closing** (closeout, finance and approvals tail) | partly (§1.6) | "Completed" |
| `CLOSED` | archived, read-only, with a financial tail | no | "Closed" (180 days) |
| `CANCELLED` | archived, read-only after the cascade | no | "Cancelled" (180 days) |

LC rules:
1. **AT_RISK.** The status menu never offers `AT_RISK`. A one-time data migration sets existing `AT_RISK` rows to `ACTIVE` (audit `project.status_normalized`). Any code that still reads `AT_RISK` treats it as `ACTIVE`. Health is internal: `atRisk` is NEVER shown in the client portal.
2. Every transition is a compare-and-set on `Project.version` (§6). It records `statusReason`, `statusChangedAt` and `statusChangedById`, writes audit `project.status` (before/after/reason), and notifies as in 1.7.

### 1.2 Allowed transitions

| From → To | Who | Reason | Gate / effect |
|---|---|---|---|
| DRAFT → PLANNING | PM | – | – |
| DRAFT → CANCELLED | PM | required | no cascade needed (nothing operational) |
| PLANNING → ACTIVE | PM | – | gate **A1** below |
| ACTIVE → PLANNING | PM | required | – |
| PLANNING/ACTIVE → ON_HOLD | PM | required | hold effects §1.6 |
| ON_HOLD → *previous* (PLANNING or ACTIVE, from the hold's audit `before.status`) | PM | – | resume effects §1.6 |
| ACTIVE → COMPLETED | PM | – | gate **C1** below; closeout task created (existing rule) |
| COMPLETED → ACTIVE | PM | required | reopen for more work |
| COMPLETED → CLOSED | `project.delete` (director/owner) | required only with override | closure gates §1.4 |
| PLANNING/ACTIVE/ON_HOLD/COMPLETED → CANCELLED | `project.delete` | required | cascade §1.3 |
| CLOSED → COMPLETED | `project.delete` | required | reopen (§1.5) |
| CANCELLED → PLANNING | `project.delete` | required | reopen (§1.5); cascaded items are **not** restored |

Every other pair is refused with `errors.invalidTransition`. `project.delete` is enforced from M2
onwards. Today it is defined but never checked.

* **Gate A1** (→ ACTIVE): an anchor date (`eventStartAt` or `deadline`) and at least one active PM.
* **Gate C1** (→ COMPLETED), none of these may remain:
  * an event in phase `LIVE`;
  * a campaign in `SCHEDULED` or `SENDING`;
  * a delivery in `OUT_FOR_DELIVERY`.

  Unmet gates are listed by name and count. There is no override; finish or cancel the item first.

### 1.3 Cancel cascade (runs in the same transaction as the status change)

The service function that sets `CANCELLED` (`setProjectStatus`) performs the cascade itself. The
confirm dialog only shows the preview (§1.4b). "Auto" = done by the system and audited per item.
"Listed" = left as-is for a human and shown in the preview and afterwards on the Operations home
(*Open commitments in archived projects*).

| Item | State | Action |
|---|---|---|
| Tasks (top-level and subtasks) | TODO / ACTIVE / BLOCKED / REVIEW | **Auto** → system status `cancelled` (category `CANCELLED`). Every workflow implicitly contains `cancelled`, even when not declared. The recurrence series stops. History row reason `project_cancelled` |
| Approvals | PENDING on TASK, DELIVERABLE, MILESTONE, DESIGN_REVISION, CAMPAIGN, PURCHASE_ORDER | **Auto** → `CANCELLED`, reason "project cancelled", no revert (existing `cancelPendingApprovalsTx`) |
| Approvals | PENDING on EXPENSE, CHANGE_ORDER | **Kept PENDING** and still decidable: money already spent or contract changes (e.g. cancellation fees). Financial tail |
| Campaigns | DRAFT / PENDING_APPROVAL / APPROVED / SCHEDULED | **Auto** → `CANCELLED`; queued `MessageJob`s → `CANCELLED` |
| Campaigns | SENDING | **Auto** → `CANCELLED`; remaining queued jobs → `CANCELLED`. Already-sent messages stay sent; the preview shows how many |
| Campaigns | ACTIVE / COMPLETED (already sent) | Unchanged. RSVP links answer "This invitation is no longer active" without event details and accept no responses or check-ins. Telling guests is **listed** (a new approved campaign, not automatic) |
| Deliveries | PENDING / VALIDATING / READY / ASSIGNED / RESCHEDULED / FAILED_ATTEMPT | **Auto** → `CANCELLED`, agent unassigned, `DeliveryEvent` reason `PROJECT_CANCELLED` |
| Deliveries | OUT_FOR_DELIVERY (in a driver's car) | **Not cancelled.** Escalated (note `project_cancelled`). The agent gets a mandatory notice "return to office". The agent may record only `RETURNED`, or `DELIVERED` if already handed over (the truth record). Dispatch may then move `RETURNED → CANCELLED` |
| Deliveries | DELIVERED / RETURNED / CANCELLED | unchanged. `CANCELLED → READY` is refused while the project is archived |
| Purchase orders | DRAFT / PENDING_APPROVAL | **Auto** → `CANCELLED` (approval cancelled with it) |
| Purchase orders | APPROVED / ISSUED / PARTIALLY_RECEIVED | **Listed** as the *vendor cancellation list* with amounts. Never auto-cancelled: a commitment may exist. They stay operable (financial tail) |
| Purchase orders | RECEIVED / CLOSED / CANCELLED | unchanged |
| Expenses | any | unchanged (financial tail) |
| Work orders | ISSUED (vendor has not accepted) | **Auto** → `CANCELLED`; the vendor's users are notified |
| Work orders | ACCEPTED / IN_PROGRESS | **Listed**; the vendor is notified "project cancelled — await instruction"; the agency decides cancel or let it complete |
| Work orders | DELIVERED | **Listed** for agency acceptance (financial tail) |
| Shifts | `SCHEDULED` and `startsAt > now` | **Auto** → status `CANCELLED` (new value of the string field); the assignee is notified |
| Shifts | started (`startsAt ≤ now`) | unchanged |
| Events | phase ≠ LIVE | **Auto** → phase `CLOSED`. A LIVE event blocks cancellation: end it first, no override |
| Run of show, readiness, logistics, booths, BOQ, snags | any | unchanged, read-only (archived) |
| Protocol guests | EXPECTED / CONFIRMED | **Auto** → `CANCELLED` |
| Incidents | open | unchanged and still operable (incident tail) |
| Change requests | OPEN / UNDER_REVIEW | **Auto** → `DECLINED`, response "Project cancelled: ‹reason›" |
| Client portal | — | read-only under "Past projects" for 180 days (§1.5). Pending client approvals show as "Withdrawn — project cancelled" |
| Notifications | — | §1.7 |

### 1.4 Close (COMPLETED → CLOSED) gates and override

| Gate | Condition to pass | Overridable? |
|---|---|---|
| G1 tasks | no open top-level task, closeout included | yes; on override open tasks → `cancelled` |
| G2 approvals | no PENDING approval | yes for non-financial ones (→ `CANCELLED`); financial ones stay PENDING (tail) |
| G3 deliveries | none outside DELIVERED / RETURNED / CANCELLED | **no** if any is `OUT_FOR_DELIVERY`; otherwise yes (→ `CANCELLED`) |
| G4 campaigns | none in DRAFT / PENDING_APPROVAL / APPROVED / SCHEDULED / SENDING | **no** for SCHEDULED/SENDING; otherwise yes (→ `CANCELLED`) |
| G5 purchase orders | none in DRAFT / PENDING_APPROVAL / APPROVED / ISSUED / PARTIALLY_RECEIVED | yes, only by a `finance.approve` holder; open POs stay operable and listed |
| G6 expenses | none `SUBMITTED` | yes, only by `finance.approve`; they stay decidable |
| G7 work orders | none ISSUED / ACCEPTED / IN_PROGRESS / DELIVERED | yes, only by `finance.approve`; listed |
| G8 incidents | none open | yes; they stay operable |
| G9 change requests | none OPEN / UNDER_REVIEW | yes (→ `DECLINED` with the override reason) |
| G10 client sign-off | every client-visible deliverable with `requiresApproval` is `APPROVED` | yes |

* LC rule 3: closing with every gate green needs no reason. Closing with any unmet gate is an **override**. It needs `project.delete`, a reason, and the per-gate permission above. Audit `project.close_override` lists every unmet gate with counts.
* LC rule 4 (preview, §1.4b): before *cancel*, *close*, *hold* or *complete*, the UI calls a read-only `projectStatusImpact(projectId, target)`. It returns:
  * every row of §1.3 or §1.4 that applies, with counts and item lists (owner, status, amount for finance-scope viewers only);
  * which rows are auto and which are listed;
  * blocking gates;
  * the client members who will be notified.

  The confirm dialog shows it and requires the reason. Cancel also has a checkbox, "Notify client contacts" (default on).

### 1.5 Archived projects: read-only rules and reopen

LC rule 5: in `CLOSED`/`CANCELLED` every mutation is refused with `errors.projectArchived`, **except**:

| Allowed in archived projects | Who |
|---|---|
| PO transitions (receive, close, cancel); expense approve/reject/mark paid; change-order decide; work-order agency accept/cancel (the **financial tail**) | `finance.manage` / `finance.approve` with project finance scope |
| Incident status, owner and resolution (the **incident tail**) | `event.manage` |
| Agent records `RETURNED`/`DELIVERED` on an in-car delivery; dispatch moves `RETURNED → CANCELLED` | agent / `delivery.dispatch` |
| Reading, file download, exports, reports | as today |
| Anonymisation and retention actions | as today (PDPL) |
| Reopen | `project.delete`, with reason |

LC rule 6, reopen:
* CLOSED → COMPLETED and CANCELLED → PLANNING clear `archivedAt`.
* Cancelled items are **not** restored. The reopen preview lists them so the PM can recreate what is still needed.
* An approval cancelled by the cascade stays cancelled; a new request is needed.

LC rule 7, client portal: archived projects stay visible to the project's client members, read-only, for 180 days after `statusChangedAt` under "Past projects": files, decided approvals and final reports. No new change requests or decisions.

### 1.6 Hold, resume and completed: what still runs

| Behaviour | ON_HOLD | COMPLETED |
|---|---|---|
| Edits to tasks, deliverables, milestones, risks, finance | allowed | allowed |
| Campaign launch; release of a scheduled send | **refused / held** | refused |
| Delivery assignment, batch creation, new shifts, applying templates | **refused** | refused |
| Field agent updates on deliveries already out | allowed | allowed (gate C1 means none should exist) |
| Approval requests and decisions | allowed (SLA clock paused) | allowed for every type except CAMPAIGN (**changes M1**: COMPLETED leaves `INACTIVE_PROJECT_STATUSES`) |
| Reminders and escalations | none | only for closeout-tagged tasks, pending approvals, work orders and POs |
| Operations home exceptions | none (the project is listed under "On hold" with its reason) | closeout items only |

LC rule 8, on resume: scheduled campaigns whose `scheduledAt` passed during the hold go to
`DRAFT` and their approval becomes `SUPERSEDED` (reason "send time passed while on hold"). The
send time is part of what was approved (M1). The PM receives one notice listing them.

### 1.7 Notifications (channel per §3)

| Event | Recipients | Channel |
|---|---|---|
| Hold / resume / complete / reopen | internal project members | in-app |
| Cancel | internal members holding open items (owners of cancelled tasks, assignees of cancelled shifts, agents with in-car deliveries — mandatory), the PMs, and the creators of listed POs/WOs | in-app + e-mail |
| Cancel, "notify client" ticked | client members of the project | in-app + e-mail: "Project ‹name› has been cancelled" (no reason text) |
| Work order cancelled or listed | the vendor's users | in-app + e-mail |
| Close with override | other owners and directors | in-app |

### 1.8 Audit events
`project.status` · `project.status_normalized` · `project.cancel_cascade` (counts per row of §1.3) ·
`project.close_override` · `project.reopen`, plus per-item rows that already exist
(`task.status`, `approval.cancel`, `campaign.cancel`, `delivery.status_change`, `po.status`,
`workorder.status`, `shift.status`, `event.phase`, `guest.attendance`, `change_request.respond`)
with `meta.cause = "project_cancelled" | "project_closed"`.

### 1.9 Acceptance criteria
* **LC-1** Given a project with an overdue owned task, when a director cancels the project, then the task's category is `CANCELLED` in the same transaction (QA `[F-22]`).
* **LC-2** Given a SCHEDULED campaign with 40 queued messages, when the project is cancelled, then the campaign is `CANCELLED`, 0 messages are sent afterwards, and the audit shows `campaign.cancel` with `cause = project_cancelled`.
* **LC-3** Given one delivery `ASSIGNED` and one `OUT_FOR_DELIVERY`, when the project is cancelled, then the first is `CANCELLED` and unassigned, the second keeps its status with `escalatedAt` set, and its agent has a mandatory notice.
* **LC-4** Given POs in DRAFT, PENDING_APPROVAL and ISSUED, when the project is cancelled, then DRAFT and PENDING_APPROVAL are `CANCELLED`, the ISSUED PO is unchanged and appears in the vendor cancellation list, and a finance user can still mark it RECEIVED.
* **LC-5** Given a PENDING expense approval, when the project is cancelled, then the approval is still PENDING and a finance approver can decide it.
* **LC-6** Given an archived project, when a PM edits a task, milestone or risk, then the request is refused with `errors.projectArchived`, and the record and its `version` are unchanged.
* **LC-7** Given a COMPLETED project with one open task, when a director closes it without a reason, then it is refused with `G1: 1` listed. When they close it with a reason, it closes, the task becomes `cancelled`, and `project.close_override` lists `G1: 1`. A PM (no `project.delete`) is refused either way.
* **LC-7b** Given an ISSUED PO, when a director without `finance.approve` closes with override, then it is refused for G5. An owner with `finance.approve` may close; the PO stays operable and is listed under "Open commitments in archived projects".
* **LC-8** Given a delivery `OUT_FOR_DELIVERY`, when anyone tries to close or complete the project, then it is refused and no override is offered.
* **LC-9** Given a PM (no `project.delete`), when they try to cancel an ACTIVE project, then it is refused; they can set ON_HOLD with a reason.
* **LC-10** Given an ON_HOLD project with an overdue task and a SCHEDULED campaign due during the hold, when the scheduler runs, then there are no overdue notices and no send. On resume after the send time, the campaign is `DRAFT` and its approval `SUPERSEDED`.
* **LC-11** Given a project set `AT_RISK` before M2, when the migration runs, then it is `ACTIVE`, and the client portal never shows "at risk" for any project.
* **LC-12** Given a cancelled project, when its client approver opens the portal within 180 days, then it is listed under "Past projects" read-only; after 180 days it is not listed.
* **LC-13** Given a cancelled project, when it is reopened by a director with a reason, then the status is `PLANNING`, `archivedAt` is null, and the cancelled tasks are still cancelled.
* **LC-14** Given the cancel dialog, when it opens, then the counts it shows equal the rows changed by the cascade (same query, tested with a fixture of every row type).

---

## 2. Departure and handover (suspend / revoke)

**Problem.** A departing person strands tasks, approvals, PM roles, incidents and shifts, and
escalations go to someone who has left (F-23).
**Owner role.** Admin (`org.members.manage`). Only an owner may suspend or revoke an owner (M1).
Nobody changes their own status (M1).

### 2.1 What a person can hold (computed by `memberHoldings(userId)`, used by preview and execution)

| # | Holding | Query | Handover action |
|---|---|---|---|
| H1 | Open tasks owned | `Task.ownerId`, category not DONE/CANCELLED | → replacement or unowned |
| H2 | Task collaborations | `TaskCollaborator` on open tasks | removed; replacement added as collaborator if chosen |
| H3 | Approvals designated to them | `Approval.approverUserId`, PENDING | → replacement if they may decide (§4); else designation cleared (back to the pool); if the pool is empty → `CANCELLED` with revert (M1 behaviour) and requester + PM notified |
| H4 | Approvals where they are the **only** eligible decider (not designated) | PENDING approvals whose `resolveApproverSet` would be empty without them | listed as "will have no eligible approver"; stays PENDING and flagged on the Operations home until someone eligible exists |
| H5 | Approvals they requested | `requestedById`, PENDING | stay PENDING (`requestedById` is kept for separation of duties). Requester notices go to the replacement or, without one, to the PMs. Optional per item: withdraw |
| H6 | Project MANAGER roles | `ProjectMember.role = MANAGER` on non-archived projects | → replacement manager (see HO rule 3) |
| H7 | Open incidents owned | `Incident.ownerId`, status OPEN/ACK/IN_PROGRESS | → replacement or unowned |
| H8 | Readiness items | `ReadinessItem.ownerId`, status ≠ READY | → replacement or unowned |
| H9 | Snags assigned | `Snag.assigneeId`, status OPEN/IN_PROGRESS | → replacement or unowned |
| H10 | Risks owned | `Risk.ownerId`, status ≠ CLOSED | → replacement or unowned |
| H11 | Run-of-show cues | `RunOfShowItem.ownerId`, status PENDING/STANDBY | → replacement or unowned |
| H12 | Future shifts | `Shift.userId`, SCHEDULED, `startsAt > now` | → replacement, subject to the existing clash check (on a clash: left open and flagged); or open shift |
| H13 | Escort assignments | `ProtocolAssignment.escortId`, status ≠ COMPLETED | → replacement or unassigned |
| H14 | Field deliveries | `Delivery.agentId` | **always automatic** (M1): ASSIGNED → READY with history; in-car → escalated. No automatic re-assignment to another driver (dispatch decides, capacity rules apply) |
| H15 | Running imports they started | `ImportBatch.createdById`, VALIDATING/COMMITTING | continue under the system; result notices go to the PMs |

### 2.2 Handover options

* **One replacement**: a single active member for every category.
* **Per-category replacements**: one person per row H1–H13.
* **Leave unowned** (per category): items keep a null owner and appear on the Operations home under **"Unowned after departure"** (owner, project, due date, the departed person's name) until assigned. They count in health as unowned (M1 criteria). **Not allowed for H6** while the person is the last active PM of a non-archived project.

HO rules:
1. Preview first. `handoverPreview(membershipId)` returns H1–H15 with counts and items per project. Execution runs in **one transaction with the status change**. If any reassignment fails validation, nothing changes and the failing rows are returned.
2. Replacement eligibility, per item:
   * an active member;
   * passes the normal assignment checks (`assertAssignable`, incident/readiness owner checks, shift clash);
   * for H3, `mayDecide` must hold;
   * a replacement not yet on the project is added as project `MEMBER` with no capability flags (audited `project.member_add`, `meta.cause = handover`).
3. **Last-manager protection.** For each non-archived project where the departing person is the only active PM, a replacement PM is **mandatory**. The replacement must hold `project.manage`. They become `MANAGER` with `canApprove/canExport/canViewFinance/canViewVip`, each capped by their own org permissions. Without one, the suspension is refused (`errors.lastManager`). The departing person's `ProjectMember` row is kept (history) with role unchanged; inactive members are ignored by every pool and fallback.
4. Assignment history: each moved task gets `TaskAssignmentHistory` with reason `handover`. Each other item gets an audit row with `meta.cause = handover`.
5. **Reactivation** (SUSPENDED → ACTIVE) restores access only. Nothing is handed back automatically, sessions are not restored, and MFA stays as it was. **REVOKED is final**: REVOKED → ACTIVE is refused; re-invite instead. *(Changes M1, where it was allowed.)*
6. **The PM leaves during an active project** (the explicit case):
   * the replacement PM is mandatory per HO-3;
   * their designated approvals are re-routed per H3;
   * open tasks go to the chosen person, or stay unowned and visible;
   * automation recipients ("project managers") are the remaining active PMs from the same transaction;
   * the client is **not** notified automatically (internal matter);
   * the replacement receives one handover notice;
   * the Operations home shows "PM changed" on the project row for 7 days.

### 2.3 Notifications
| Event | Recipients | Channel |
|---|---|---|
| Handover received | each replacement: one consolidated notice ("23 items from ‹name›", grouped by project) | in-app + e-mail, **mandatory** |
| Items left unowned | the PMs of each affected project: one notice per project | in-app + e-mail |
| Approval re-routed or cancelled | requester + new approver set | in-app (+ e-mail for the new approvers, mandatory) |
| Suspension/revocation of an owner | other owners | in-app + e-mail |
The departing person receives nothing.

### 2.4 Audit
`member.suspended` / `member.revoked` / `member.active` · `member.handover` (counts per H-row,
replacements, unowned categories) · per-item rows with `meta.cause = handover` ·
`approval.reassigned` (from, to).

### 2.5 Acceptance criteria
* **HO-1** Given a PM with 5 open tasks, 1 designated approval, 2 incidents and 3 future shifts, when an admin suspends them with one replacement, then all 11 items reference the replacement in one transaction, and the replacement receives exactly one handover notice.
* **HO-2** Given the only PM of an ACTIVE project, when an admin suspends them without a replacement PM, then it is refused with `errors.lastManager` and the membership is still ACTIVE.
* **HO-3** Given a designated approver who leaves and a replacement without decide authority, then the designation is cleared and the approval stays PENDING for the remaining pool. If the pool is empty, it is `CANCELLED` with revert and the requester is notified.
* **HO-4** Given "leave unowned" for tasks, then the tasks have no owner and appear under "Unowned after departure" on the Operations home with the departed person's name.
* **HO-5** Given an agent with one ASSIGNED and one OUT_FOR_DELIVERY delivery, when suspended, then the first is READY with history and the second is escalated (M1 regression).
* **HO-6** Given a replacement with a clashing shift, when the handover runs, then that shift is left open, flagged, and listed in the result; the rest of the handover succeeds.
* **HO-7** Given a REVOKED member, when an admin sets ACTIVE, then it is refused.
* **HO-8** Given a reactivated SUSPENDED member, then none of their former items are reassigned back.
* **HO-9** Given the handover preview, then its counts equal the rows changed by the execution (same `memberHoldings` query).

---

## 3. Notifications and escalation

**Problem.** Notices never left the app, repeated daily per task, and escalation meant "overdue by
one tick" (F-26, S3 operations). **[D3]**: in-app plus transactional e-mail now, with tracking,
retries, dedupe and escalation. WhatsApp later.

### 3.1 Architecture rules
1. Every notice is one `Notification` row (in-app) for one recipient. Its `dedupeKey` is unique per org; a second create with the same key is a no-op.
2. If the type is e-mail-eligible (3.2), the recipient's preference allows e-mail (or the type is mandatory), and the recipient has an e-mail address, then one `NotificationDelivery` (channel `EMAIL`) is created **in the same transaction** with dedupe key `‹notification dedupeKey›:email`.
3. A sender process (worker or scheduler tick) claims deliveries with `status IN (PENDING, FAILED) AND nextAttemptAt ≤ now`, with compare-and-set to `SENDING`.
4. Recipients are **active members only**. Inactive recipients are replaced by the fallback (PMs → directors → owners) where the rule says "fallback", otherwise dropped.
5. E-mail content: the recipient's locale (Arabic RTL or English), entity code + title + deep link. **NEVER** VIP contact data (mobile, e-mail, address), protocol notes or amounts. Client recipients see only client-visible titles.

### 3.2 Event → recipient → channel matrix

M = mandatory (in-app and e-mail cannot be switched off). "Opt" = e-mail optional, default on unless marked "off".

| Type | Recipients | In-app | E-mail |
|---|---|---|---|
| `approval.requested` | approver notify-set (M1 `resolveApproverSet.notify`) | ✓ | **M** |
| `approval.reminder` / `approval.overdue` / `approval.escalated` | per ladder 3.4 | ✓ | **M** |
| `approval.decided` (approved) | requester; for client decisions also the PMs | ✓ | Opt |
| `approval.rejected` | requester + entity owner | ✓ | Opt |
| `approval.cancelled` / `withdrawn` / `superseded` / `reassigned` | requester, approver set, previous decider | ✓ | Opt (off) |
| `task.assigned` | new owner | ✓ | Opt |
| `task.due_soon` (24 h) | owner | ✓ | digest only |
| `task.overdue` L1 | owner | ✓ | Opt |
| `task.escalated` L2 / L3 | PMs / directors (consolidated, 3.4) | ✓ | **M** |
| `comment.mentioned` | mentioned users | ✓ | Opt (off) → digest |
| `incident.reported` HIGH/CRITICAL, `incident.escalated` | per ladder 3.4 | ✓ | **M** |
| `incident.reported` MEDIUM/LOW | PMs | ✓ | – |
| `incident.assigned` | new incident owner | ✓ | **M** if HIGH/CRITICAL, else – |
| `delivery.assigned` | agent (field app) | ✓ | – |
| `delivery.failed` (follow-up) | PMs | ✓ | Opt (off) |
| `delivery.deadline_risk` | per ladder 3.4 | ✓ | **M** |
| `workorder.overdue` / `workorder.escalated` | per ladder 3.4 (vendor users at L1) | ✓ | **M** |
| `workorder.delivered` (vendor marks delivered) | WO creator + PMs | ✓ | Opt |
| `import.completed` / `import.failed` / `import.stalled` | actor (+ PMs for stalled) | ✓ | Opt (failed/stalled default on) |
| `campaign.stalled` / `campaign.late` | launcher + PMs | ✓ | **M** |
| `event.approaching` | PMs | ✓ | Opt |
| `project.*` | per §1.7 | ✓ | per §1.7 |
| `handover.received` | replacement | ✓ | **M** |
| `change_request.created` / `responded` | PMs / client requester | ✓ | Opt |
| `exception.self_approval` (§4) | other owners | ✓ | **M** |
| `digest.daily` | each internal active user with ≥ 1 item | – | Opt (preference "digest") |
| Security: password reset link, password changed, MFA enabled/disabled/reset, recovery code used | the account itself (`SystemEmail`) | – | **M** |

NT rules:
1. The separate `campaign.approval_requested → org_admins` rule is **retired**: `approval.requested` covers it. One person NEVER gets two notices for one request.
2. **Daily digest** at 07:30 Riyadh. One e-mail per user per day (`digest:‹userId›:‹YYYY-MM-DD›`), sent only when non-empty:
   * overdue items they own;
   * items due today;
   * approvals waiting on them;
   * mentions since the last digest.
3. Preferences: users may switch off in-app and e-mail for non-mandatory types. Mandatory types show as locked in the preference UI. The e-mail column shows "Simulated — e-mail not configured" while the channel is simulated (3.3, rule 4).

### 3.3 Delivery states, retries, dedupe, simulation

| State | Meaning | Next |
|---|---|---|
| `PENDING` | created, waiting for the sender | SENDING |
| `SENDING` | claimed by a sender (compare-and-set) | SENT · SIMULATED · FAILED · DEAD |
| `SENT` | accepted by the SMTP server (`providerMessageId` stored). SMTP has no receipt: SENT ≠ read | terminal |
| `SIMULATED` | channel not configured; rendered and stored, **not sent** | terminal |
| `FAILED` | transient error; `nextAttemptAt` set by backoff | SENDING |
| `DEAD` | permanent error (invalid address, 5xx permanent) or the 5th failed attempt | terminal; retry is manual (§7.4) |
| `SUPPRESSED` | no address, inactive recipient, or preference off at send time | terminal |

NT rules:
1. Backoff after failure *n*: 1 m, 5 m, 30 m, 2 h, 6 h. The 5th failure → `DEAD`. A `SENDING` row older than 10 minutes is reclaimable (crash recovery). E-mail is at-least-once; the dedupe key makes a duplicate visible in the record.
2. **Dedupe keys** identify the *occurrence*, not the day:
   * `task.overdue:‹taskId›:‹dueAt ISO›:L‹n›`
   * `approval.overdue:‹approvalId›:L‹n›`
   * `incident.escalated:‹incidentId›:L‹n›`
   * `workorder.overdue:‹woId›:‹dueAt›:L‹n›`
   * `delivery.deadline:‹campaignId›:‹deadline›:‹tier›`

   A changed due date or deadline starts a new occurrence. **No notice repeats daily for the same item**; the daily digest is the only recurring reminder.
3. **Consolidation**: escalation notices for the same recipient, tier and type within one scheduler tick become **one** notice ("7 tasks escalated to you", linking to the filtered Operations view). Each item still records its own escalation level.
4. **Simulation**: when `SMTP_URL` is unset or the EMAIL provider mode is SIMULATION, deliveries end `SIMULATED`:
   * never shown or counted as sent;
   * the Settings → Providers and System-health pages show "E-mail: simulated — nothing leaves the system";
   * the reset-password page still shows the generic message (§5.1);
   * outside production the link is printed only to the server console.

### 3.4 Escalation ladders (scheduler-driven, each tier once per occurrence)

**Tasks** (`Task.escalationLevel` 0 → 3):

| Tier | When | To | Effect |
|---|---|---|---|
| L1 | `dueAt` passed | owner; if unowned, skip to L2 now | `escalationLevel = 1` |
| L2 | due + 24 h | the project's PMs | `escalationLevel = 2`, `escalatedAt` set (from now on "escalated" means L2+) |
| L3 | due + 72 h | directors | `escalationLevel = 3` |
* Unowned tasks due within 3 days → one notice to the PMs (`task.unowned_due:‹id›:‹dueAt›`).
* The ladder stops when the task is DONE or CANCELLED. It **restarts at L0** when `dueAt` changes (re-plan, audited with reason) or the owner changes.

**Approvals** (`dueAt` = the request's `dueAt` or request + `APPROVAL_SLA_HOURS`):

| Tier | When | To |
|---|---|---|
| Reminder | due − 24 h (only when SLA ≥ 36 h) | approver notify-set |
| L1 | due | approver set + requester |
| L2 | due + 24 h | internal: the project's PMs. **Client approvals**: PMs + requester ("chase the client"), plus one more reminder to the client approver set |
| L3 | due + 48 h | directors. Spend approvals: directors + `finance.approve` holders other than requester and creator |
The ladder ends when the approval is decided, withdrawn, cancelled or superseded. On ON_HOLD the clock pauses: due dates shift by the hold duration when the project resumes.

**Vendor work orders** (resolves QA `[S3-3]`):

| Tier | When (status ISSUED/ACCEPTED/IN_PROGRESS) | To |
|---|---|---|
| Not-accepted reminder | ISSUED and issue + 48 h | vendor users + WO creator |
| L1 | `dueAt` passed | vendor users + WO creator (emits `workorder.overdue` with `workOrderId` in the payload) |
| L2 | due + 24 h | PMs |
| L3 | due + 72 h | directors |
The ladder stops on DELIVERED, ACCEPTED_BY_AGENCY or CANCELLED, or restarts when `dueAt` changes.

**Incidents** (from `reportedAt`; *acknowledged* = status left `OPEN`, i.e. ACKNOWLEDGED, IN_PROGRESS or RESOLVED, set by a member with `event.manage`; the time and actor are recorded in the audit):

| Severity | At report | Not acknowledged after | Then |
|---|---|---|---|
| CRITICAL | PMs + directors + incident owner (M) | 15 min → L2: directors + owners, `escalationLevel + 1` | 60 min → L3: all owners again, marked "unacknowledged 1 h" |
| HIGH | PMs + directors (M) | 60 min → L2: directors | – |
| MEDIUM | PMs (in-app) | 4 h → L2: PMs by e-mail | – |
| LOW | PMs (in-app) | – | – |
A manual "escalate" (existing) raises severity and restarts the ladder at the new severity.

**Deliveries near the campaign deadline** (`InvitationCampaign.deliveryDeadline`, consolidated per campaign). The ladder counts deliveries not DELIVERED, CANCELLED or RETURNED-and-closed.

| Tier | When | To |
|---|---|---|
| T1 | deadline − 48 h and ≥ 1 delivery not out, or in FAILED_ATTEMPT/RESCHEDULED past the deadline | PMs |
| T2 | deadline − 24 h, condition still true | PMs + directors |
| T3 | deadline passed with undelivered cards | directors; shown on the Operations home as "missed" |
* Failed-attempt follow-up tasks: **at most one open follow-up task per delivery** (dedupe on `deliveryId`). A new failure on the same delivery appends to that task's description instead of creating another.

### 3.5 Acceptance criteria
* **NT-1** Given an approval with no designated approver and three eligible approvers, when it is requested, then three in-app notices and three e-mail deliveries exist, and one more identical emit creates none.
* **NT-2** Given SMTP unset, when a mandatory notice is created, then its delivery ends `SIMULATED`, and no surface shows it as sent.
* **NT-3** Given an SMTP 4xx error four times then success, then the delivery is `SENT` with `attempts = 5`. Given five failures, it is `DEAD` and appears in System health.
* **NT-4** Given a task overdue for 5 days with no due-date change, when the scheduler runs every 5 minutes, then the owner received exactly one L1 notice, the PMs one L2 and the directors one L3.
* **NT-5** Given the due date moved forward by 2 days (with reason) and then passed again, then a new L1 is sent (new occurrence).
* **NT-6** Given 7 tasks reaching L2 for the same PM in one tick, then the PM receives one consolidated notice.
* **NT-7** Given a user who turned off e-mail for `task.assigned`, then no delivery is created. Given mandatory `approval.requested`, the preference cannot be turned off.
* **ES-1** Given a work order due yesterday and still IN_PROGRESS, when `schedulerTick` runs, then an outbox event whose payload contains the work-order id exists (QA `[S3-3]`), and the vendor's users have an L1 notice.
* **ES-2** Given a CRITICAL incident still OPEN after 15 minutes, then the directors and owners have an L2 notice and `escalationLevel = 1`. Given it is ACKNOWLEDGED at minute 10, no L2 is sent.
* **ES-3** Given an approval requested at T with the default SLA, then the reminder is at T + 24 h, L1 at T + 48 h, L2 at T + 72 h and L3 at T + 96 h, each sent once.
* **ES-4** Given a client approval at L2, then the PMs and the requester are notified and the client approvers get exactly one more reminder.
* **ES-5** Given a campaign whose deadline is 40 h away with 12 deliveries not out, then the PMs receive one consolidated T1 notice naming 12.
* **ES-6** Given three failed attempts on one delivery, then exactly one open follow-up task exists for it.
* **ES-7** Given no daily repeats: given an overdue task, when the scheduler runs on 3 consecutive days with nothing changed, then no new `task.overdue` notices are created after L3; only the digest lists it.

---

## 4. Approval policy ([D4], [D5])

**Problem.** Separation of duties must be strict by default, allow "the performer approves when
someone else requested" [D4], and allow a controlled exception for very small organisations [D5].

### 4.1 Default policy (`approvalPolicy = STANDARD`)
1. **The requester never decides** (all types; M1).
2. **Spend** (PO, expense, change order): the creator/submitter never decides (M1); `finance.approve` and finance scope are required.
3. **Campaigns**: `campaign.approve` is required; the requester never decides.
4. **Performer may decide** when someone else requested: the task owner, deliverable author, campaign author and revision author are *not* excluded by default **[D4]**. The two QA tests `[F-02 residual]` are rewritten: default → the decision succeeds (AP-1, AP-2); strict → refused (AP-3, AP-4).
5. A designated approver narrows the set and never grants authority (M1). Client approvals go only to client approvers of the project's client (M1).

### 4.2 Strict policy (`approvalPolicy = STRICT`, org setting, owner only, audited `org.approval_policy`)
In addition to 4.1, the **performer** may not decide. The performer is defined per type, evaluated at decision time:

| Entity | Performer(s) |
|---|---|
| TASK | current owner + collaborators |
| DELIVERABLE | users who uploaded its current attachments, or who last moved it to SUBMITTED |
| MILESTONE | owners of the milestone's open or completed tasks in its workstream (if none: the requester only) |
| CAMPAIGN | `createdById`, plus anyone who changed content, audience or send time since the last approval (from audit `campaign.update` / `campaign.audience`) |
| DESIGN_REVISION | `createdById` + uploaders of its attachments |
| Spend | already strict (creator) |

AP rule 6: a project flag `independentApprovalRequired` (a quiet, advanced project setting) applies **STRICT to that project** whatever the org setting, and excludes the exception in 4.3.
* Setting it needs `project.delete` (director/owner).
* Clearing it needs the same plus a reason.
* Audit `project.independent_approval`.

### 4.3 Small-organisation exception ([D5])
*Self-approval by the requester when nobody else can decide.* **Simple by default, power behind
disclosure** (founder direction, 2026-10-25): the surface is one plain toggle for owners, "Allow
self-approval when no one else can approve". Everything else has a sensible default and sits under
"Advanced". No regulatory wording in the UI.

| Aspect | Rule |
|---|---|
| Default | **off** |
| Who turns it on | an **owner** only. Not a director. One toggle; no justification or form is required to turn it on (the change is audited and the other owners are told) |
| Defaults when turned on | every type in scope (PO, EXPENSE, internal CHANGE_ORDER, CAMPAIGN, internal TASK/DELIVERABLE/MILESTONE/DESIGN_REVISION); a per-item spend cap of SAR 250,000 incl. VAT (also the hard maximum *— owner to confirm*); a campaign audience cap of 500 (*— owner to confirm*); **no expiry** |
| Advanced (collapsed, owner only) | narrow the types; lower the caps; an **optional** end date (must lie ahead when set); the org STRICT policy (§4.2) and the approval time (`approvalSlaHours`) live in the same section |
| **Never applies to** | CLIENT approvals; projects with `independentApprovalRequired`; approvals with a designated approver; spend above the cap; campaigns above the audience cap |
| What it lifts | only "requester ≠ decider" and, for spend, "creator ≠ decider". Authority by type still applies. An org-level STRICT policy does not disable the exception; the project flag does |
| Per-approval preconditions (all) | exception on and, when an end date was set, not past it; type in scope; under the caps; the standard approver set (§4.1/4.2) is **empty**; the requester holds the authority for the type (`finance.approve` + finance scope, `campaign.approve`, or project approve scope) |
| Request | when the preconditions hold, the request is accepted instead of failing with `errors.noEligibleApprover`, and is marked "exception-eligible" |
| Decision | only by the requester, approve only; needs a **one-line note** (≥ 3 characters) and an explicit confirmation. The decision sets `Approval.policyException = true`, `policyExceptionReason` = the note |
| Audit | `org.approval_exception_enabled` / `_updated` / `_disabled` (who, scope, caps, end date); `approval.self_approved` (approval, amount or audience, note) |
| Visibility | every self-approval notifies all **other** owners (mandatory, in-app + e-mail) and appears on the Operations home for owners and directors under "Self-approved under exception" for 30 days. Settings shows the monthly count and amount |
| Disabling | any owner, at any time, immediately (the same toggle); or automatically at the end date when one was set. Exception-eligible approvals still PENDING then need a normal second approver, are flagged "no eligible approver", and are never auto-decided |
| A second approver appears | the exception stops applying to *new* approvals at once (the precondition "standard set empty" fails); pending exception-eligible approvals become decidable by the new approver |

### 4.4 Acceptance criteria
* **AP-1** (default) Given a task owned by PM A with an approval requested by employee B, when A decides, then the decision succeeds. *(Rewrites QA `[F-02 residual]` #1.)*
* **AP-2** (default) Given a campaign written by director D with approval requested by PM P, when D approves, then it succeeds. *(Rewrites `[F-02 residual]` #2.)*
* **AP-3** (strict) Given the AP-1 setup with `approvalPolicy = STRICT`, when A decides, then it is refused, and the approver set excludes A.
* **AP-4** (strict per project) Given STANDARD org policy but `independentApprovalRequired` on the project, when D approves as in AP-2, then it is refused.
* **AP-5** Given the exception off and an owner who is the only finance approver, when they submit a PO above threshold, then it is refused with `errors.noEligibleApprover` (M1 regression).
* **AP-6** Given the exception on (PO in scope, cap 100k) and the same owner, when they submit a PO of 80k, then the request is accepted; deciding without a note is refused; with a note it is APPROVED with `policyException = true`; the other owners receive a mandatory notice; the Operations home lists it.
* **AP-7** Given the AP-6 setup with a PO of 120k, then it is refused (`errors.noEligibleApprover`).
* **AP-8** Given the exception on, when a client approval or a project with `independentApprovalRequired` is involved, then the exception never applies.
* **AP-9** Given an exception whose optional end date was yesterday, when the owner tries to self-approve, then it is refused, and the pending approval shows "no eligible approver".
* **AP-10** Given a director (not an owner), when they try to enable the exception, then it is refused.
* **AP-11** Given an owner, when they turn the exception on with the toggle alone, then it is on with every type, the default caps and no end date; an end date in the past is refused.

---

## 5. Account security

### 5.1 Password reset
| Rule | Value |
|---|---|
| Request | `POST /forgot` with an e-mail. **Always** the same response and comparable timing whether or not the account exists, is locked or has no password |
| Token | 32 random bytes; SHA-256 stored as `PublicToken(kind = PASSWORD_RESET)`; expires in **30 min**; **single use**; issuing a new token invalidates earlier unused ones for that user |
| Rate limits | 3 requests per e-mail per hour; 10 per IP per hour. Over the limit: the same generic response, no e-mail |
| E-mail | `SystemEmail` template `password_reset` with the link. The link is **not persisted** (params never hold the token). A failed send is not retried with the same token: the record ends FAILED/DEAD and the user requests again |
| Reset page | valid, unexpired, unused token, plus the existing password policy (≥ 10 characters, no trivial pattern). On success: new hash, `passwordChangedAt`, token consumed, **every session revoked**, failed-login counter and lockout cleared. **No automatic sign-in**; MFA still applies at the next login |
| Invalid or expired token | a neutral page, "This link is no longer valid — request a new one". No detail on why |
| Confirmation | mandatory e-mail "Your password was changed" (with the time; no link that undoes it) |
| Admin action | an admin may click "Send reset link" for a member. Same flow and limits; audit `member.reset_link_sent`; the admin never sees the link |
| Audit | `auth.password_reset_requested` and `auth.password_reset_completed`, written to every organisation where the user has an ACTIVE membership (no row when the e-mail is unknown) |

### 5.2 MFA (TOTP + recovery codes)
| Rule | Value |
|---|---|
| Algorithm | TOTP (RFC 6238), SHA-1, 6 digits, 30 s step, ±1 step accepted. **Replay protection**: a step ≤ `mfaLastStep` is refused |
| Enrolment | `/account`, after re-entering the current password. Show the secret and QR; confirm with one valid code; then generate **10 recovery codes**, shown once and stored as SHA-256. Mandatory e-mail "MFA enabled" |
| Login | password OK + MFA enrolled → **no session yet**. A `PublicToken(kind = MFA_CHALLENGE)` lasts 5 min, single use. 5 wrong codes invalidate the challenge and count toward the existing account lockout. A correct code creates the session |
| Recovery code | accepted in place of a TOTP; single use. Mandatory e-mail "a recovery code was used". With ≤ 2 codes left, the user is prompted to regenerate (regenerating needs password + TOTP) |
| Disable own MFA | password + current TOTP. **Refused** if any org the user belongs to requires MFA for their role |
| Admin reset (lost device) | an owner, or a director for non-owner members; never for oneself. Requires a reason. **Refused** if the user has an ACTIVE membership in another organisation (MFA is per account): "contact Opera support". Effect: MFA cleared, all sessions revoked, mandatory e-mail to the user, notice to the other owners, audit `auth.mfa_reset_by_admin` |
| Org policy | org setting `mfaRequired`, set by an owner only, audited `org.mfa_policy`. **Privileged roles** (required when on): any role holding `org.manage`, `org.members.manage`, `org.roles.manage`, `finance.approve`, `campaign.approve` or `automation.manage`, i.e. OWNER and OPS_DIRECTOR plus such custom roles. Optional extension: "also require for VIP data access" (`vip.viewSensitive`, which covers PMs), default **off** *(owner decision)* |
| Default for new orgs | `mfaRequired = true` for privileged roles |
| Grace and enforcement | **14 days** from the later of: the policy being switched on, or the user gaining a privileged role. During grace: a banner, login works. After grace: login yields an **enrolment-only session**, which can reach only `/account` MFA enrolment and logout, until enrolment |
| Scope | login only. Step-up for individual actions is not in M2 |

### 5.3 Acceptance criteria
* **PW-1** Given an unknown e-mail and a known e-mail, when each requests a reset, then the responses are byte-identical, and only the known one creates a `SystemEmail`.
* **PW-2** Given a token used once, when it is used again, then it is refused. Given a token 31 minutes old, it is refused.
* **PW-3** Given a user with 3 sessions, when the reset completes, then 0 sessions remain, and a "password changed" e-mail exists.
* **PW-4** Given a 4th request within an hour for the same e-mail, then the response is generic and no e-mail is created.
* **PW-5** Given MFA enrolled, when the user logs in after a reset, then the TOTP step is still required.
* **MFA-1** Given a correct password and MFA, then no session exists until a valid code is entered. The same code used twice is refused the second time.
* **MFA-2** Given 5 wrong codes, then the challenge is invalid and the failure counts toward lockout.
* **MFA-3** Given a recovery code, then login succeeds once, the code is consumed, and an e-mail is sent.
* **MFA-4** Given an org requiring MFA and a director not enrolled for 15 days, when they log in, then only enrolment and logout are reachable.
* **MFA-5** Given a user who belongs to two orgs, when an admin of one tries an MFA reset, then it is refused.
* **MFA-6** Given a director in an org requiring MFA, when they try to disable their own MFA, then it is refused.

---

## 6. Concurrent editing

**Problem.** A stale form silently overwrote a newer save (QA `[S3-1]`).

CE rules:
1. **Protected records**: Project, Milestone, Risk, Deliverable, Budget (line), Recipient, Guest, Booth, Event, InvitationCampaign; plus Task and Delivery (already protected). Each has an integer `version`.
2. **Every update and status transition** of a protected record MUST carry the `version` the user loaded. The write is `UPDATE … WHERE id = ? AND version = ?` and increments `version`. A **missing `version` is rejected** (`errors.validation`), never treated as "latest". The only exceptions are field offline replays (idempotency key + version as today) and system or automation writes, which increment `version` without requiring one.
3. **Mismatch** → `409 CONFLICT` (`errors.conflict`) with: the current record; the list of fields that differ from what the user loaded; who changed it and when (latest audit row). Nothing is written.
4. **What the user sees**:
   * the form stays, with their input;
   * a notice: "‹name› changed this at ‹time›";
   * a per-field comparison for the fields that differ ("theirs" vs "yours").

   Actions:
   * **Reload**: discard my changes.
   * **Re-apply mine**: resubmit only the fields *I* changed, against the new version. That is a new CAS and may conflict again.
   * **Cancel**.

   There is no "overwrite anyway".
5. **Bulk actions** (bulk task update, bulk assign) CAS each row on the version read inside the same transaction. Rows that conflict are skipped and reported (as today for deliveries).
6. **Creates are idempotent** — *deferred to Milestone 3 (orchestrator decision): it addresses double submission, not concurrent editing, and touches every create path. In M2 the UI prevents double submission (pending, disabled actions).* Target rule: create actions carry a client-generated `idempotencyKey` (UUID); a repeat with the same key within 24 h returns the first result and creates nothing.
7. **Dependency edits** stay serialised per project (M1 fix); adding an edge re-checks for cycles inside the lock.

* **CE-1** Given two managers who loaded a project at version 3, when A saves a new name and then B saves a description from the stale form, then B gets `409` with the differing fields, and the name is still A's (QA `[S3-1]`, which calls the service without a version and must be refused).
* **CE-2** Given B chooses "Re-apply mine", then only the description is written, at version 5.
* **CE-3** Given an update without `version` on any protected record, then it is refused.
* **CE-4** *(Milestone 3, see rule 6)* Given a double-clicked "create risk" with the same `idempotencyKey`, then exactly one risk exists.
* **CE-5** Given an automation reopens a task while a user's form is open, when the user saves, then they get `409` (automation bumps `version`).

---

## 7. Stalled work recovery

### 7.1 Imports (VALIDATING / COMMITTING)
1. Entering VALIDATING or COMMITTING sets `leaseOwner` (request or worker id), `leaseUntil = now + 120 s` and `attempts + 1`. The processor renews the lease after every chunk (≤ 1000 rows) and at least every 60 s.
2. **Recovery sweep** (scheduler tick) for an expired lease:

   | Stage | attempts < 3 | attempts ≥ 3 |
   |---|---|---|
   | VALIDATING | **resume**: restart validation (idempotent: rows are replaced as a whole) | `FAILED`, error `import.stalled`, notice to the actor |
   | COMMITTING | **resume** from the first row not `COMMITTED`. Each row is committed at most once (row status CAS `→ COMMITTED` in the same transaction as its recipient/delivery) | `PARTIALLY_COMMITTED` if any row committed, otherwise `FAILED`. Notice to the actor + PMs; rollback is still available |
3. User-visible: the progress shows **"Paused — resuming automatically"** while the lease is expired. **Resume** (actor or `recipient.import` holder) appears once the lease has been expired > 120 s. It runs the same resume path and counts as an attempt.
4. Before full parsing, the row count from the sheet dimension is checked against `IMPORT_MAX_ROWS` (default 10,000 *— assumption*). Over the cap → refused with a clear message, no batch processing.
5. **Rollback** refuses (existing `errors.rollbackUnsafe`) when any recipient of the batch is in a digital audience (`DigitalInvitation` exists), in addition to the existing checks (F-24).

### 7.2 Campaign dispatch (SENDING) and scheduled sends
1. While SENDING, `dispatchLeaseUntil = now + 120 s`, renewed per batch of ≤ 200 messages; `dispatchAttempts + 1` per (re)start.
2. **Recovery sweep**: SENDING with an expired lease and messages still `QUEUED` → resume (`dispatchAttempts` < 5). At 5 → the campaign stays SENDING with **"stalled"** shown, an Operations home exception, and a mandatory notice to the launcher + PMs. Actions for `campaign.send` holders: **Resume sending** or **Cancel remaining** (queued → CANCELLED).
3. **At most once per guest**: a `MessageJob` found in `SENDING` for > 10 min has an unknown outcome. It is **not resent automatically** for LIVE providers: it becomes `FAILED` with error `outcome_unknown` and is listed for manual review (resend one by one). SIMULATION jobs may be retried. Idempotency key `campaign:invitation:initial` is unchanged.
4. **Scheduled sends**: the scheduler releases SCHEDULED campaigns when `scheduledAt ≤ now` and the project is operational (M1).
   * If a release happens more than **30 min** after `scheduledAt` (scheduler was down), the campaign is **not sent**. It is marked "late", gets an Operations home exception and a mandatory notice to the launcher + PMs. Sending requires a new send time, which voids the approval (M1 binding) and goes back through approval with priority HIGH.
   * Within 30 min it sends normally.

### 7.3 Other scheduled or background work
| Work | Stall rule |
|---|---|
| Outbox events | as today: dead after 5 attempts (`attempts ≥ 5`); listed in System health with **Retry** (resets attempts to 0, audited `system.outbox_retry`) |
| Automation executions | FAILED listed in System health (7 days) with the error; Retry = re-run the event (idempotent claim) |
| Notification deliveries | `DEAD` listed in System health with **Retry** (→ PENDING, attempts 0, audited) |
| Scheduler | `lastTickAt` stored per deployment; see 7.4 |

### 7.4 System health (owners and directors; `/o/[org]/settings/health`)
| Signal | Warning | Critical |
|---|---|---|
| Scheduler last tick | > 15 min | > 60 min (escalation timers in §3.4 are not met; also shown as a banner on the Operations home) |
| Dead outbox events (org) | ≥ 1 | ≥ 10 |
| Failed automation executions, 7 days | ≥ 1 | – |
| Dead notification deliveries, 7 days | ≥ 1 | ≥ 10 |
| E-mail channel | SIMULATED (info) | – |
| Stalled imports / campaigns / late scheduled sends | ≥ 1 (warning) | campaign stalled or late (critical) |
| Message jobs `outcome_unknown` | ≥ 1 | – |
| MFA coverage (privileged members not enrolled after grace) | ≥ 1 | – |
| Data residency status (§9) | not verified, for an org flagged in-Kingdom | – |

* **SW-1** Given a COMMITTING import whose process died after 600 of 1000 rows, when the sweep runs after the lease expires, then the import resumes, ends `COMMITTED` with 1000 rows, and no recipient is duplicated.
* **SW-2** Given three failed resumes of a VALIDATING import, then it is `FAILED` with `import.stalled`, and the actor has a notice.
* **SW-3** Given an expired lease, then "Resume" is offered and works once. A second click within the same lease does nothing.
* **SW-4** Given a SENDING campaign that died after 120 of 300 messages, when the sweep runs, then exactly 300 messages exist in total and none is sent twice.
* **SW-5** Given a LIVE-provider message stuck in SENDING for 11 min, then it is `FAILED` with `outcome_unknown` and not resent.
* **SW-6** Given a scheduler outage and a release 45 min after `scheduledAt`, then nothing is sent, the campaign shows "late", and the launcher has a notice.
* **SW-7** Given a file with 12,000 rows and the default cap, then upload validation refuses it before parsing rows.
* **SW-8** Given a committed import whose recipients were added to a digital campaign, when rollback is requested, then it is refused with `errors.rollbackUnsafe`.
* **SW-9** Given the scheduler did not tick for 20 min, then System health shows a warning for scheduler freshness.

---

## 8. Remaining known defects (PRODUCT_AUDIT §6.1), one rule each

| ID | Rule | Test |
|---|---|---|
| **KD-1** Vendor work-order escalation | the work-order ladder in §3.4 | ES-1 / QA `[S3-3]` |
| **KD-2** Import decoy sheet | Auto-select the sheet with the highest **header score**: the number of columns in its detected header row that match the mapping dictionary. Ties go to the sheet with more non-empty data rows. A sheet with < 2 recognised headers or < 2 data rows is never auto-selected while another qualifies. The user can always override. A prose "instructions" sheet placed first is never picked over a guest sheet | QA `[S4-3]`: picks `المدعوين` |
| **KD-3** Formula-looking names | A text value (after trimming) starting with `=`, `+`, `-`, `@`, TAB or CR, in a name, organisation, address or notes field, adds a **WARNING** `import.formulaLike`. The row is not invalid; the value is imported as literal text and exports neutralise it. Phone fields are exempt for `+`. Real formula cells keep the existing rule (cached result only) | QA `[S4-4]` |
| **KD-4** Phone numbers in XLSX exports | XLSX: every user value is written as a **string cell** (never a formula cell). Values matching E.164 `^\+\d{8,15}$` in phone columns are written **unprefixed**. Other values starting with `=` or `@` keep the `'` neutralisation (defence in depth). CSV keeps the OWASP rule unchanged | QA `[S4-2]`; the CSV injection regression stays green |
| **KD-5** Finance overview performance | `financeOverview` MUST issue **< 30 SQL statements for 40 projects**, constant in the number of projects. Project finance scope is resolved for all projects in one query, never `projectScope` per project. Budget for every org-level page: ≤ 30 statements, independent of project count | `[arch · financeOverview N+1]` |
| **KD-6, KD-7** F-02 residuals | **Resolved by [D4]**: allowed by default (AP-1, AP-2), refused under STRICT or the project flag (AP-3, AP-4). Convert both `it.fails` tests accordingly | qa-m1-bypass |
| **KD-8** Lost update on project edits | §6 | CE-1 / QA `[S3-1]` |
| **KD-9** Cancel leaves tasks open | §1.3 | LC-1 / QA `[F-22]` |

---

## 9. Data residency ([D2])

**Stance.** The product is *architected* for Saudi-region deployment. M2 adds **configuration and
checks only**: no infrastructure migration. Sensitive government customer data is not processed
until the deployment's residency has been verified.

### 9.1 What data exists and where it lives
| Store | Contents | Sensitivity |
|---|---|---|
| PostgreSQL (+ backups/snapshots) | all tenant records: VIP names, honorifics, mobiles, addresses, geo, protocol levels and restricted notes, guest lists, finance, audit trail, sessions | **High** |
| Object storage (S3 / Vercel Blob / local) | import originals (full VIP lists), evidence photos, receiver names, design files, exports, reports | **High** |
| Redis / BullMQ | job payloads (ids only, by rule), rate-limit counters | Low (ids) |
| E-mail provider (SMTP) | staff and client e-mail addresses, entity titles, links; never VIP contact data (§3.1 rule 5) | Medium |
| SMS / WhatsApp providers | VIP mobile numbers + invitation text | **High** |
| Application and worker logs | must contain ids only; **NEVER** names, mobiles, e-mails, tokens or notes | Low if the rule holds |
| Driver devices (IndexedDB offline queue) | today's assigned deliveries incl. contact data while active | High (device-side) |
| Third-party maps (deep links) | delivery address, sent by the driver's device to Google/Apple Maps | Medium |

### 9.2 Must be in-Kingdom for government work *(to be verified by the owner and legal)*
The database and its backups; object storage; compute that processes tenant data (app + worker
functions); Redis; logs containing any personal data; the SMS provider. For e-mail, either an
in-Kingdom provider or the no-VIP-data rule plus owner sign-off. WhatsApp (Meta Cloud API) is
excluded for government projects until verified.

### 9.3 What the product does in M2
1. Deployment configuration declares regions: `DATA_RESIDENCY` (`SA` | `ANY`), `APP_REGION`, `DB_REGION`, `STORAGE_REGION` (default: derived from `S3_REGION` or the driver), `EMAIL_REGION`, `SMS_REGION`, plus `ALLOWED_REGIONS_SA` (a list maintained by operations). The product does not hard-code providers. Note: AWS `me-central-1` (the current `.env.example` default) is UAE, **not** in-Kingdom.
2. `DATA_RESIDENCY_VERIFIED=true` may be set only by Opera operations after verification (an attestation, not a code check).
3. An org setting `requiresInKingdomData` (owner only, audited).
4. When it is on and (`DATA_RESIDENCY ≠ SA`, or any declared region is outside `ALLOWED_REGIONS_SA`, or not verified):
   * System health shows "Residency: not verified";
   * a banner shows for owners and directors;
   * **VIP data intake is blocked for that org**: imports, recipient/guest creation, and LIVE messaging providers (`errors.residencyNotVerified`).

   Existing data stays readable.
5. Logging rule: a unit test asserts that the logger's redaction strips the PII fields (names, mobile, e-mail, address, token).

* **DR-1** Given `requiresInKingdomData` on and `DB_REGION` not in the allowed list, when a PM uploads an import, then it is refused with `errors.residencyNotVerified`, and System health shows the reason.
* **DR-2** Given all regions allowed and `DATA_RESIDENCY_VERIFIED=true`, then intake works and System health is green for residency.
* **DR-3** Given any server error during an import, then the logged line contains no mobile number or name from the file.

---

## 10. Naming ([D1])
User-visible text, e-mail templates, export metadata (`wb.creator`), SMTP headers (`X-Opera-Ref`),
the system actor name and the docs say **"Opera"**, never "Operra". Product copy keeps Opera's
*execution services* (corporate site) separate from its *software products* (Opera Technologies).
Workspace e-mails are signed "Opera" and never claim that Opera runs the customer's event.
* **NM-1** A repository check (test) finds no "Operra" in `src/`, `prisma/seed.ts`, e-mail templates or docs, except migration history.

---

## 11. Decisions still needed from the owner
1. **Self-approval exception caps** (§4.3): hard maximum per spend item (proposed SAR 250,000 incl. VAT), monthly aggregate cap (proposed none), campaign audience cap (proposed 500), maximum duration (proposed 90 days).
2. **MFA for VIP-data roles** (§5.2): require MFA for `vip.viewSensitive` holders (PMs) by default? Proposed: off by default, recommended on for government projects.
3. **Client approval SLA**: the same 48 h as internal, or longer (e.g. 72 h)? And is one extra client reminder at L2 enough?
4. **Client notification on cancel**: default on (proposed), or off?
5. **Portal visibility of archived projects**: 180 days (proposed)?
6. **Late scheduled send window** of 30 min (§7.2): send automatically within it, require re-approval beyond it?
7. **In-Kingdom provider list** (§9.2) and whether e-mail may leave the Kingdom under the no-VIP-data rule.
8. **MFA reset for users in several organisations** needs an Opera support process (who verifies identity).
9. **Digest time and days**: 07:30 every day, weekends included (proposed)?

## 12. Assumptions made
* Timers are calendar hours in Asia/Riyadh. Agencies work weekends around events.
* Production runs the scheduler every ≤ 5 minutes. Vercel Hobby's daily cron does **not** meet §3.4; System health makes that visible.
* SMTP gives no delivery receipt: `SENT` means "accepted by the SMTP server".
* "Directors" fall back to owners when an org has no active director.
* `IMPORT_MAX_ROWS = 10,000` default.
* Shift `status` is a string, so `CANCELLED` needs no migration. The system task status `cancelled` is valid in every workflow.
* Expenses and change orders in a cancelled project remain decidable (financial tail): money already spent must still be accounted for.
* The approval performer for a milestone is approximated from the owners of its workstream's tasks; there is no milestone owner field.

## 13. Not in Milestone 2
WhatsApp notifications; quiet hours; bounce or complaint webhooks for e-mail; e-mail address
verification at registration; step-up MFA for sensitive actions; WebAuthn/passkeys; waiting-on-
client and change-request conversion (F-27); event-date re-anchoring and the born-overdue warning;
complete anonymisation and scheduled retention (F-25); DataTable v2 and saved views; automation rule
builder; template dashboards; live-provider verification with real accounts; infrastructure
migration to a Saudi region; CSP nonces; vendor-submitted quotes; routing/ETA; org logo branding.
