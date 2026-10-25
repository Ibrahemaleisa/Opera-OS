# Opera — product audit, findings register and execution plan

Shared record of the five-agent product audit (October 2026) and the work that follows from it.
It complements, and does not replace, PRODUCT_SPEC / ARCHITECTURE / SECURITY / IMPLEMENTATION_PLAN.

**How the audit was run.** Five specialist agents audited the system in parallel against the live
application (dev server, seeded demo agency, real PostgreSQL with RLS), each in its own domain:
product & operations (1), systems architecture (2), UI engineering (3), product design (4),
quality & risk (5). Every finding below is **verified** — by a failing automated test, a
reproducible HTTP/Playwright probe, or a cited code path — unless marked *assumed*. Agents 2 and 5
wrote 63 probe tests; 55 of them failed on the audited code, each one a defect listed here.

Baseline at audit time: typecheck clean; lint 0 errors / 23 warnings; 57/57 unit+integration
tests and 6/6 Playwright specs passing.

---

## 1. Verdict

Opera's foundations are stronger than its surface. Tenant isolation is database-enforced and held
under every cross-tenant probe; the VIP delivery state machine, Excel Import Studio, offline driver
app, protocol module, booth stage gates and audited exports are genuinely production-capable.

It is **not yet an operating system a COO can trust**, for three reasons:

1. **Controls that look enforced are bypassable.** Approvals could be self-granted; the four-eyes
   rule on bulk invitations did not bind the audience or the message; a "scheduled" campaign was
   sent immediately; client and driver accounts could load internal agency pages; a client kept
   access after their project moved to another client.
2. **The core operating loop is broken.** *Something needs a decision → the right person is told →
   it is decided before the event → management can see that it happened.* Approvals without a
   named approver notified nobody and appeared in nobody's queue; the home page counted problems
   but never listed them; the health score called a project with 0 % done and 11 overdue tasks
   "Good"; finance showed a green 100 % margin on a plan that exceeds the contract.
3. **Failure paths are unfinished.** The driver app did not actually open offline; a failed form
   submission replaced the workspace with an error page and lost the user's input; destructive
   actions fired on one click.

| Readiness level | Verdict | Evidence |
|---|---|---|
| Demo ready | **Yes** | E2E acceptance specs green; every surface renders for its role on a production build |
| Pilot ready | **Yes, after Milestone 1** — with the owner decisions in §7 | Every S1 and the S2 controls F-01–F-21 fixed and re-verified by QA against bypass attempts (§6.1) |
| Production ready | **No** | Milestone 1 + owner-acknowledged gaps (password reset, MFA, email, CSP, retention automation, live provider verification, data residency decision) |

## 2. What Opera does well (keep and build on)

* **Tenant isolation**: RLS on every tenant table, non-owner `NOBYPASSRLS` runtime role, per-transaction
  tenant context, append-only audit for the app role. 12-way cross-tenant probe sweep: all rejected.
* **VIP delivery**: 10-state machine with compare-and-set, idempotent offline replay, evidence, Import
  Studio with normalisation (Arabic digits, Saudi mobiles), duplicate resolution, consented partial commit.
* **Protocol**: levels, seating capacity rules, restricted notes with audited reveal.
* **Booth production**: cumulative stage gates (design → BOQ → permit → inspections → handover).
* **Bilingual foundations**: correct `lang`/`dir`, logical CSS (no physical CSS outside primitives),
  0 horizontal overflow at 390 px across 224 page visits, 0 contrast violations, Hijri/Gregorian dates.
* **Brand**: a restrained token system; login, corporate site, booth gate and field app already express
  the Opera identity well.

**Differentiation (Agent 1):** the defensible wedge is *Arabic VIP invitation delivery + protocol +
client approvals in one record* — something neither generic PM tools (weak RTL/Hijri, no VIP registry,
no driver app, no protocol) nor registration-first event software provide. Candidate North Star:
**client commitments met on time, with proof** (deliveries with evidence before the deadline,
deliverables approved by their due date, booths handed over on time) — computable from existing records.

## 3. Findings register (consolidated, deduplicated)

Severity: **S1** data leak/loss or broken trust control · **S2** blocks commercial use · **S3** moderate · **S4** minor.
Owner: 1 Product · 2 Systems · 3 UI Eng · 4 Design · 5 QA. Status is updated as work lands.

### S1 — fix before any pilot

| ID | Finding | Source | Owner | Status |
|---|---|---|---|---|
| F-01 | Client, driver and vendor accounts load internal `/o` pages via RSC soft-navigation — the only role gate was in the layout, which partial rendering skips. Leaked all internal task titles, staff e-mails, incidents, VVIP arrivals | 2, 5 (HTTP repro) | 2 | **Fixed** (QA-verified) |
| F-02 | Approval engine bypass: self-designated approver with no approve authority; requester ≠ decider only for campaigns/finance; financial SoD keyed on the clicker, not the creator; generic request revives a cancelled PO / approves an expense without evidence; decisions overwrite stale entities | 2, 5 (probes) | 2 | **Fixed** (QA-verified) |
| F-03 | Campaign four-eyes not bound to what is sent: recipients added after approval are sent (approved 1, sent 3); body editable while pending | 2, 5 (probes) | 2 | **Fixed** (QA-verified) |
| F-04 | Scheduled campaigns send immediately when jobs run inline (the documented Vercel mode) | 1, 2, 5 (probe + code) | 2 | **Fixed** (QA-verified) |
| F-05 | A client keeps portal access after the project is moved to another client | 2, 5 (probe) | 2 | **Fixed** (QA-verified) |
| F-06 | RSVP token expiry stored but never checked — forwarded VIP links live forever | 2, 5 (probe) | 2 | **Fixed** (QA-verified) |
| F-07 | Driver app does not open offline: the service worker clones responses after the body is consumed, so nothing is cached | 3 (Playwright) | 3 | **Fixed** (QA-verified) |

### S2 — blocks commercial use or trust

| ID | Finding | Source | Owner | Status |
|---|---|---|---|---|
| F-08 | Approvals without a designated approver notify nobody and appear in nobody's queue (the default for client, PO, expense, change-order, revision approvals); no withdraw/reassign; a stuck PENDING blocks re-requests | 1, 4, 5 | 2 | **Fixed** (QA-verified) |
| F-09 | Reopened approval-gated work re-completes on the stale approval; `requiresApproval` can be switched off by the task owner | 1, 2, 5 | 2 | **Fixed** (QA-verified) |
| F-10 | Management cannot see what is at risk today: home shows counts with no lists, links dead-end, counts include closed/cancelled projects (dashboard 14 overdue vs portfolio 11) | 1, 4 | 4 (spec), 3/4 build | **Fixed** (QA-verified) |
| F-11 | Health score misleads (81 "Good" at 0/43 done, 11 overdue, event in 18 days); portfolio and overview compute it differently; ignores the event date; factors shown in English inside Arabic | 1, 4 | 1 → 4 | **Fixed** (QA-verified) |
| F-12 | Margin overstated: forecast ignores uncommitted plan (green 100 % on a plan above contract) | 1, 4 | 4 | **Fixed** (QA-verified) |
| F-13 | Read-model leaks inside a tenant: task detail lists every project task to freelancers/clients; overview shows the risk register and activity feed (VIP names, seats, amounts) to freelancers and non-VIP/non-finance members; signed download URL for files on tasks the caller can't see; Import Studio shows unmasked VIP mobiles and leaks another project's VIP via org-wide duplicate detection; client search returns internal task titles | 1, 2, 5 (probes) | 2 | **Fixed** (QA-verified) |
| F-14 | Automation executions run more than once under concurrency (78 notifications for 40 events; duplicate follow-up tasks) | 2 (probe) | 2 | **Fixed** (QA-verified) |
| F-15 | Login open redirect (`next=/\evil.example`) | 5 (Playwright) | 2 | **Fixed** (QA-verified) |
| F-16 | Workstream-restricted members edit any task via bulk update; an ops director can suspend or demote the owner | 2, 5 (probes) | 2 | **Fixed** (QA-verified) |
| F-17 | A failed server action (e.g. network loss) replaces the workspace with the root error page and loses input (37 call sites) | 3 (Playwright) | 3 | **Fixed** (QA-verified) |
| F-18 | Offline queue not scoped to the user; rejected items silently dropped while the UI says "Synced" | 3 (Playwright) | 3 | **Fixed** (QA-verified) |
| F-19 | Destructive actions on one click (revoke member, cancel campaign/PO/work order, no-show, escalate); mandatory reasons via `window.prompt`; 37/65 action buttons without pending state | 3 | 3 | **Fixed** (QA-verified) |
| F-20 | Arabic dates scrambled on client-facing pages (forced LTR); Arabic-Indic digits silently empty number fields | 3 | 3 | **Fixed** (QA-verified) |
| F-21 | Login/register/invite forms submit as GET before hydration → password in the URL | 3 | 2/3 | **Fixed** (QA-verified) |
| F-22 | Project status drives nothing: cancel/close leaves tasks, campaigns, deliveries, POs and reminders live; closed projects stay editable | 1, 2, 5 | 1 → 2 | Part: scheduler skips inactive projects, approvals/launch refused (M1) · cascade wizard M2 |
| F-23 | Ownership optional and invisible (73/76 open demo tasks unowned); suspending a member strands their tasks, approvals, PM role and in-flight deliveries; escalations go to the suspended person | 1, 4, 5 | 1 → 2 | Part: unowned work on the Operations home, inactive recipients skipped, suspension releases deliveries and withdraws approvals (M1) · handover M2 |
| F-24 | Imports and full campaign sends run in-request when inline; VALIDATING/COMMITTING/SENDING can stick with no recovery; rollback hard-deletes recipients still in a digital audience | 2 (probes) | 2 | M2 |
| F-25 | Anonymisation leaves PII in guests, invitations, import rows, messages, RSVPs | 2 (probe) | 2 | M2 |
| F-26 | Notifications never leave the app (email toggle shown but nothing is sent) | 1 | 2 | M2 (channels need an owner decision) |
| F-27 | No "waiting on client": the portal shows the client's own overdue inputs as "upcoming"; accepting a change request creates nothing | 1 | 1 → 2 | M2 |

### S3 / S4 — moderate and minor (abridged; full detail in the agent reports)

* **Concurrency**: no optimistic concurrency on project, recipient, guest, booth, event, campaign,
  milestone, risk, budget (lost update reproduced on project edits); dependency-cycle check races (real
  cycles created); creates are not idempotent under double submit. → M2
* **Integrity**: `maxAttempts` never enforced; offline replay accepts back-dated `deliveredAt`; comments
  attachable to another project's entity; rejection automation writes status keys that don't exist in
  custom workflows; booth/vendor rules read audit-log text. → M1 (comments, status keys) · M2 (rest)
* **Operations**: overdue vendor work orders never escalate; escalation fires on the first overdue tick
  and repeats daily per task; LOW/MEDIUM incidents and incident owners are never notified; booths,
  vendors and finance emit no automation events; event-date changes don't move template dates and
  projects are born overdue without warning. → M2/M3
* **Performance**: finance overview is N+1 (90 statements for 40 projects); 22 foreign keys lacked
  indexes; pages issue 30–50 sequential round trips. → M1 (indexes) · M2
* **UI**: raw keys and English validation messages in the Arabic UI; labels not associated with inputs
  (148/160), no `aria-invalid`; English hydration mismatch in compact money; DataTable starves the title
  column, no mobile card mode; 12-tab project chrome pushes content to y≈350; primary-button inflation;
  stale command-palette results; delivery lists ship ~3.75 KB/row. → M1 (forms, keys) · M2
* **Docs vs reality**: SECURITY.md said RLS is "forced" (it is enabled; the runtime role is not the
  owner, so it applies) and that RSVP links expire; the owner DB client is reachable from cron/worker
  paths. → M1 (docs corrected)

## 4. Module classification (verified)

| Class | Modules |
|---|---|
| Production-capable | Tenant isolation, audit storage, Import Studio, delivery state machine + offline sync (server), protocol, booth gates, reports |
| Functional but incomplete | Tasks, portfolio, events/incidents, vendors/procurement, finance, client portal, vendor portal, notifications (in-app), resources, automation defaults |
| Prototype | Project lifecycle (free-form status), health/at-risk, inline background jobs |
| Broken (as controls) | Approvals, campaign approval and scheduling, workspace role gate, field offline launch |
| Missing but essential | Exception board, approval routing/withdraw, handover on leave, waiting-on-client, email notifications, password reset/MFA |
| Unnecessary now | Automation rule builder, template dashboards, saved views, vendor quote portal, four parallel portfolio views |

## 5. Design direction (Agent 4)

Operational rules a designer or engineer can check:

1. **Exception first, inventory second.** Fewer than three categories is a sentence, not a chart.
2. **Every number is a doorway** — it carries its denominator or window and links to the list behind it.
3. **Show the gap.** A missing owner, date, approval, budget or venue is a first-class state with words.
4. **The event date is the spine** — countdowns, and timelines that run from today to the event.
5. **One violet action per screen**; row actions stay quiet.
6. **Exact language** — no raw keys, isolated user content, numbers never wrap, per-entity state labels.
7. **Grain by role and moment** — dense at the desk, 48 px targets in the field; each role lands on its own question.

Brand primitives as interaction patterns: **Ring** = bounded progress (closed ring = complete),
**Gap** = a required piece is missing, **Dot** = you-are-here / today / live, **Line** = sequence and
time (path to event, stage gates, run of show), **Field** = a tinted, borderless group (at most one
emphasis field per screen).

## 6. Execution plan

Priority = operational criticality × risk reduction × dependency order ÷ effort. Business logic before
polish; fewer, complete workflows over many partial ones.

### Milestone 1 — trustworthy controls and an operational command loop *(done)*

| Stream | Owner | Contents | Findings |
|---|---|---|---|
| 1 Trustworthy controls | Agent 2 | secure-by-default surface gate; client-company binding; RSVP expiry; open redirect; approval authority, separation of duties, stale-decision CAS, withdraw, supersede on reopen, approver-set routing + "awaiting me" query; campaign audience/content lock, real scheduling, cancel; idempotent automation claims, `after()`, inactive-recipient fallback, workflow-aware reopen, scheduler skips inactive projects; read-model scoping; member hierarchy; FK indexes | F-01–F-06, F-08, F-09, F-13–F-16, F-22/23 (part) |
| 2a Interaction safety | Agent 3 | field PWA offline launch + user-scoped queue + attention tray; failure containment (`useAction`, per-shell error/404); ConfirmAction / ActionButton; DateText/Bdi; Arabic-digit inputs; Field a11y; zod messages in the user's language | F-07, F-17–F-20 |
| 2b Operational command | Agent 4 (rules: Agent 1) | Operations home (needs-you, exceptions, next events, portfolio rows); My work (decisions first, time buckets, all owned commitments); health v2 anchored on the event date; honest margin | F-10–F-12, F-23 (visibility) |
| Integration | Orchestrator | health wiring, auth forms as POST, zod map install, docs | F-21 |
| Gate | Agent 5 | independent re-run of all probes + full suites + E2E; promote probes to regression tests | — |

### 6.1 Milestone 1 — result and evidence

**QA gate (Agent 5): accepted with conditions; both blocking conditions were fixed and re-tested
before commit.** QA re-ran every original probe and tried to bypass each fix on the development
server and on a production build: crafted RSC requests for every external role on 11 internal pages,
encoded / backslash / dot-segment redirect variants, self-approval via designation, other entity
types and withdraw-then-request, campaign edit-then-launch and early scheduler ticks, RSVP expiry at
±1 s, read-model scoping for freelancer, workstream-restricted, non-VIP and non-finance members.

| Gate finding | Resolution |
|---|---|
| F-15 bypass: `next=/..//evil.example` normalised into a protocol-relative URL | `safeNextPath` now rejects a normalised result starting with `//`; QA's bypass tests pass |
| F-13: pending spend approvals (PO title, amount) visible to members without finance scope | Overview and approvals list exclude PO / expense / change-order approvals without finance scope |
| F-03 residual: clearing an approved campaign's send time sent it immediately | The send time is part of what the approval binds; changing it voids the approval |
| F-13 residual: failed-delivery follow-up task titles carried the VIP's name | Follow-up tasks name the delivery card (tracking code) instead |
| F-19 residual: project cancel/close and campaign launch were one click | Both are confirmed in a dialog that states the consequence |

**Test evidence at commit.** `pnpm typecheck` clean · `pnpm lint` 0 errors (14 warnings, down from
23) · `pnpm test` **219/219** (29 files, real PostgreSQL with RLS; up from 57) · Playwright E2E
**7/7** on the development server, and the field-offline spec on a production build (offline
reload hydrates from the service-worker cache) · `next build` succeeds. Production timings on the
seven heaviest pages: TTFB 49–97 ms, DOMContentLoaded 102–290 ms on a local database.

**Known defects kept as executable `it.fails` tests** — they pass while the defect exists and turn
red the day it is fixed, so they cannot be forgotten:

| Test | Finding | Plan |
|---|---|---|
| qa-workflows: lost update on project edits | S3-1 concurrency | M2 |
| qa-workflows: overdue vendor work orders escalate | S3-3 | M2 |
| qa-workflows: cancelling a project closes its open tasks | F-22 cascade | M2 |
| qa-import: decoy instructions sheet auto-selected | S4-3 | M2 |
| qa-import: formula-looking names imported without warning | S4-4 | M2 |
| qa-import: XLSX phone numbers gain a leading apostrophe | S4-2 | M2 |
| qa-m1-bypass: the person who did the work approves it when a colleague filed the request | F-02 residual | owner decision §7.4 |
| qa-m1-bypass: a campaign's author approves it when a colleague filed the request | F-02 residual | owner decision §7.4 |
| arch-audit/perf-roundtrips: finance overview is N+1 (~90 statements for 40 projects) | performance | M2 |

### Milestone 2 — lifecycle and resilience

Project lifecycle with gates and a cancel/close cascade (P4); offboarding and handover (P5);
resumable background work with leases and recovery for imports and sends; complete anonymisation and
scheduled retention; optimistic concurrency on live-ops records; idempotent creates; email
notifications and a daily digest (P8, channels need an owner decision); waiting-on-client and change
control (P7); event-date re-anchoring (P6); DataTable v2.

### Milestone 3 — commercial readiness

Password reset and e-mail verification, MFA, CSP with nonces, organisation onboarding, data export,
live-provider verification, production-build performance budget, third-party penetration test.

## 7. Decisions needed from the owner

These change direction or cost and were **not** decided by the team:

1. **Product strategy and naming.** The corporate site presents Opera as an execution company running
   its own projects on an in-house platform; the product is self-serve multi-tenant SaaS for agencies
   (who are Opera's competitors), and the docs used a misspelled product name while the UI says "Opera".
   *Decided: see §7.1.*
   Internal OS, separately-branded SaaS, or client-facing portal as a service differentiator? The
   answer decides billing, platform administration, CRM and ZATCA invoicing scope.
2. **Data residency.** The deployment region is `iad1` (US East). Saudi government VIP lists likely
   require in-Kingdom hosting under PDPL and procurement rules.
3. **Notification channels and cost** — e-mail first; WhatsApp needs approved templates and per-message cost.
4. **Approval policy defaults** — whether the person who did the work (or authored a campaign) may
   approve it when a colleague filed the request (allowed today; two `it.fails` tests document it),
   default approval SLA (the board assumes 48 h when none is set), escalation path for client approvals.
5. **Separation of duties in very small agencies.** Spend at or above the approval threshold, bulk
   campaigns and change orders now need a second eligible person. An agency whose only finance or
   campaign approver is the requester gets a clear refusal ("nobody can approve this request yet").
   Before Milestone 1 such requests were accepted but could never be decided. Options: keep the
   strict rule (recommended for government work), or allow an owner self-approval with a mandatory
   justification that is audited and flagged on the Operations home.

### 7.1 Owner decisions (October 2026, before Milestone 2)

| # | Decision | Where it is applied |
|---|---|---|
| 1 | Opera is the parent brand; Opera Technologies develops the operational software, which serves agencies and organizations managing complex operations; execution services stay distinct; the name is "Opera", never "Operra" | README, PRODUCT_SPEC, UI and e-mail strings; legacy infrastructure identifiers kept and listed in ARCHITECTURE.md §10 |
| 2 | Architect for Saudi-region deployment and data residency where required; no infrastructure migration and no sensitive government data until requirements are verified | BUSINESS_RULES.md §9 (configuration and checks only) |
| 3 | In-app notifications and transactional e-mail first, with delivery tracking, retries, deduplication and escalation; WhatsApp later | BUSINESS_RULES.md §3 |
| 4 | Requester ≠ approver and spend creator ≠ approver stay; the person who performed the work may approve when someone else requested, unless a stricter organisation policy applies | BUSINESS_RULES.md §4.1–4.2 |
| 5 | Strict separation by default; an explicitly enabled, justified, audited and restricted exception for small organisations that never overrides regulatory or contractual requirements | BUSINESS_RULES.md §4.3 |

Remaining questions raised while specifying Milestone 2 are listed in BUSINESS_RULES.md §11.

## 8. Decisions taken by the team (reversible)

* Role gating is **secure by default**: `requirePageContext` assumes the agency workspace unless a page
  declares another surface, so new pages cannot forget the check.
* Reopening approved work **supersedes** the approval (new `SUPERSEDED` state) rather than deleting it,
  preserving the decision history.
* Health is **one computation** shared by every surface, anchored on the event date, with reasons in the
  user's language; "at risk" is derived from data, not a manually set status.
* Margin uses a forecast that includes uncommitted plan, so it is never better than the plan allows.
* Every probe test written during the audit is either a passing regression test for a fixed defect or a
  documented open defect — none is weakened to pass.
