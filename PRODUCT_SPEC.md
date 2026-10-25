# Opera — Product specification

Opera is an Arabic-first (RTL, with full English LTR) operations platform developed by Opera
Technologies for agencies and organizations that manage complex operations: events,
conferences, exhibitions, protocol, VIP invitation delivery and exhibition construction. One
deployment serves many organizations (tenants), each isolated at the database. Opera's own
execution services are a separate business and are not modelled as product modules.

## Users

| Persona | Where they work | What they need |
|---|---|---|
| Agency owner / ops director | `/o/[org]` | portfolio health, approvals (campaigns, finance), staffing, margins |
| Project manager | `/o/[org]/projects/[id]` | compose projects from templates, run tasks, imports, dispatch, events, booths, budgets |
| Team lead / employee / freelancer | workspace, *My work* | assigned tasks, shifts, incidents; freelancers see only their own tasks |
| Field delivery agent | `/field/[org]` (mobile PWA) | today's deliveries, navigation, proof (photo, receiver, GPS), works offline |
| Client contact / approver | `/portal/[org]` | approved progress, approvals with comments, shared files, change requests |
| Vendor | `/vendor/[org]` | their work orders, status updates, file hand-over |
| VIP guest (anonymous) | `/rsvp/[token]` | confirm attendance, receive a QR entry code, opt out |

## Modules and behaviour

### Organisation & access
Agency registration, members and invitations (expiring links), system roles (owner, ops
director, PM, team lead, employee, freelancer, field agent, client, client approver,
vendor) plus custom roles, clients/contacts, venues, custom fields, audit log, settings
(branding colour, finance approval threshold, recipient retention period), messaging
providers, automation rules. Permissions are enforced server-side at org, project,
workstream, record, finance, export, approval and VIP-data level.

### Projects & templates
A project is composed from one or more **templates** (9 bilingual starters: VIP physical
delivery, VIP digital campaign, corporate event, conference, exhibition, VIP protocol,
booth production, pavilion production, blank). Templates are versioned; applying one
creates a template instance (snapshot) with workstreams, tasks (offsets from the event
date), milestones, deliverables, custom fields, budget lines and operational records.
Key collisions between templates are prefixed, never merged. Templates can be added to
an existing project later. Views: portfolio list/kanban/calendar/timeline; project
overview with a health score, workstreams, milestones, deliverables, risks, approvals,
team, activity; project edit (client, dates, references).

### Tasks
Per-workstream statuses mapped to fixed categories; owner, collaborators, priorities,
estimates, due dates, dependencies (cycle-checked, block completion), checklists,
comments with @mentions, attachments, approval-gated completion, recurrence, bulk
actions; list, board, calendar, timeline and workload views; *My work*.

### VIP physical delivery (flagship)
* **Recipient registry** per project with tiering, verification status, retention.
* **Excel Import Studio**: upload XLSX/CSV, sheet + header-row detection, suggested and
  saved column mappings, normalisation (Arabic digits, Saudi mobiles to E.164, names,
  cities), validation with per-row issues, duplicate detection (project or organisation,
  configurable keys), bulk resolution (skip / import as new / link existing), partial
  commit only with explicit consent, idempotent chunked commit (worker for large files),
  rollback, downloadable error/normalised/original reports.
* **Delivery cards** (one per recipient per campaign) with a 10-state machine, history,
  attempts, evidence, priorities and windows; bulk assignment with capacity checks;
  dispatch board; agent re-assignment.
* **Driver PWA**: assigned cards sorted by status, call/navigate deep links, status
  updates with photo evidence and receiver name, GPS capture, offline queue (IndexedDB)
  with idempotent replay and conflict reporting.
* **Analytics** from live records: completion, on-time, failure reasons, per-agent
  performance; Excel export of deliveries (masked unless VIP scope).

### Digital invitations
Email/SMS/WhatsApp campaigns with personalised templates and variables; audience from
the recipient registry (addresses re-derived when the channel changes); **bulk sends
require four-eyes approval**; scheduled or immediate launch; provider adapters (SMTP,
Unifonic SMS, WhatsApp Business Cloud API) used only when credentials are configured,
otherwise a clearly labelled **simulation** provider; retry with backoff; signed delivery
webhooks; public RSVP page with QR entry code; opt-out → suppression list; check-in desk;
guest-list export.

### Events & conference operations
Event phases, agenda sessions and speakers (contacts masked), run of show with live cue
control (one live cue, compare-and-set), staff shifts with clash detection and check-in,
readiness checklist (default per event, issues need a note), incidents (report,
acknowledge, assign, escalate, resolve with mandatory resolution, close, reopen),
logistics; an org-wide **live command center** that refreshes every 30 s.

### VIP protocol
Guest registry (from recipients or manual), categories and protocol levels, seating
zones with capacity and minimum level, seat labels, escorts/checkpoints/transport,
arrival desk (expected → confirmed → arrived → seated → departed, with no-shows),
restricted notes with audited reveal, org arrivals board for level 1–2 guests.

### Booths & pavilions
12-stage production pipeline with **gates** (submitted design → approved design → BOQ →
permit → required inspections and no blocking snags → signed handover); design revisions
with files and internal or client approval; bill of quantities with estimate/committed/
actual; inspections; snag list with independent verification; handover sign-off.

### Vendors, procurement & finance
Vendor directory with performance computed from work orders/quotes/POs; RFQs with quote
comparison (lowest flagged) and award (justification if not lowest) creating a draft PO;
work orders progressed by the vendor and accepted/rated by the agency. Finance per
project: budget lines, contract value + approved change orders, planned vs committed vs
actual vs forecast, margin; POs with threshold approval; expenses with evidence and
approval; change orders approved internally or by the client; org finance overview.

### Client & vendor portals
Client portal shows only client-visible items and counts only completed work as progress;
deliveries and RSVPs as aggregates; approvals with mandatory comments on rejection;
shared files; change requests and the agency's responses. Vendor portal shows only the
vendor's own work orders.

### Notifications, automation, reports
Transactional outbox → automation rules (17 defaults: assignment/due-soon/overdue
notices, escalation, failed-delivery follow-up tasks, approval notices and re-opening,
incident alerts, import results, event readiness, closeout checklist) with idempotent
executions and an execution log; in-app notification centre with per-type preferences;
resources/capacity board; permission-gated, audited CSV reports (portfolio, open tasks,
incidents, vendor performance, finance summary).

### Internationalisation
Arabic default and English, per-user locale, mirrored layouts (logical CSS), Asia/Riyadh
time, SAR formatting, Gregorian or Hijri (Umm al-Qura) dates, Latin digits for data
entry with Arabic-digit normalisation on import.

## Out of scope / not built
See IMPLEMENTATION_PLAN.md → "Remaining work". Notably: MFA, password reset, email
notifications/digests, automation rule builder UI, saved views, routing/ETA, live-provider
verification with real credentials.
