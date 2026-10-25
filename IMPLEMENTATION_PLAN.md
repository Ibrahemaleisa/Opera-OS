# Operra Events OS — Implementation plan & status

Status as of the current `claude/operra-events-os` branch. "Done" means implemented,
reachable in the UI, and covered by at least one automated test (unit, integration or
E2E) — not merely scaffolded.

## Test inventory

| Suite | Command | Coverage |
|---|---|---|
| Unit (10 files) | `pnpm test:unit` | phone and import normalisation, pure logic (state machine, templates, CSV safety, recurrence …), health v2, finance forecast, Arabic-digit input and zod messages, offline-queue ownership, safe redirects (incl. bypass variants), vendor registration numbers |
| Integration (19 files) | `pnpm test:integration` | the original module suites, plus `operations-board` and the audit regression suites `arch-audit/` (approvals state and routing, campaign controls, role and data boundaries, double submit, round trips) and `qa-audit/` (workflows, digital, import, Milestone 1 bypass attempts). Open defects are `it.fails` tests named with their finding ID (PRODUCT_AUDIT.md §6.1) |
| E2E (7 specs) | `pnpm test:e2e` | the acceptance scenario, digital campaign, events/protocol, production/finance, field offline (queue, attention tray, offline reload), corporate site, smoke render of every org page |

Last full run (Milestone 1): typecheck clean; lint 0 errors; 219/219 unit+integration tests
(real PostgreSQL with RLS); E2E green against `next dev`; field-offline spec green against a
production build.

## Phases

| # | Phase | Status |
|---|---|---|
| 1 | Foundations: auth, sessions, tenancy (RLS), authorization, design system, org management | **Done** |
| 2 | Projects, template composition & versioning, workstreams, tasks, approvals | **Done** |
| 3 | VIP physical delivery: registry, Import Studio, delivery cards, dispatch, driver PWA (offline), analytics | **Done** |
| 4 | Digital invitations: providers (simulation + live adapters), approval-gated sends, webhooks, RSVP, opt-out, QR check-in | **Done** (live adapters unverified — see below) |
| 5 | Events & conference ops, live command center, VIP protocol | **Done** |
| 6 | Booths & pavilions, vendors & procurement, finance, resources | **Done** |
| 7 | Automation settings, client & vendor portals, notifications, account, reports | **Done**, with the partial items below |
| — | Seed, samples, Docker, docs | **Done** (Docker images not built in this environment — no daemon) |

## Milestone 1 (product audit) — done

See PRODUCT_AUDIT.md for the findings register and evidence. Delivered: secure-by-default
surface gate; client-company binding; RSVP expiry; open-redirect fix; approval authority,
separation of duties (incl. creator), routing to every eligible approver, withdraw, supersede
on reopen, stale-decision compare-and-set; campaign approvals bound to content, audience and
send time; real scheduling in inline mode; idempotent automation; scoped read models (task
detail, overview, activity, files, import review, search); member hierarchy; FK indexes;
Operations home and My work; health v2; honest margin; field PWA offline launch, user-scoped
queue and attention tray; failure containment; confirmations for destructive actions; Arabic
dates and digits; accessible form fields; localized validation messages.

## Remaining work, re-prioritised after the audit

Ordered by operational criticality × risk reduction ÷ effort. Each item names where it goes.

1. **Owner decisions** (PRODUCT_AUDIT.md §7): product strategy and naming, data residency,
   notification channels, approval policy defaults, separation of duties in small agencies.
2. **Project lifecycle with gates and a cancel/close cascade** — cancel open tasks, queued
   messages and unsent deliveries, list POs to cancel with vendors, read-only archived projects
   (`projects/service.ts setProjectStatus`, scheduler, field queries). `it.fails` test F-22.
3. **Offboarding and handover** — reassign a leaving member's tasks, approvals, PM role and
   incidents in one step (`org/service.ts setMemberStatus` + a settings dialog).
4. **Password reset and e-mail verification**, then **e-mail notifications and a daily digest**
   (one e-mail path serves both); hide the e-mail preference until it sends.
5. **Resumable background work** — leases and a scheduler sweep for imports
   (VALIDATING/COMMITTING) and campaign sends (SENDING); row cap checked before parsing.
6. **Optimistic concurrency** on project, recipient, guest, booth, event, campaign, milestone,
   risk and budget edits; idempotency keys on create actions. `it.fails` test S3-1.
7. **Waiting on client and change control** — client-owed inputs shown as overdue in the
   portal; accepting a change request drafts tasks and/or a change order.
8. **Event-date re-anchoring** — shift template-derived dates when the event moves; warn when a
   template would create work that is already overdue.
9. **MFA**, **CSP with nonces**, composite `(organizationId, id)` foreign keys, upload malware
   scanning hook, `Promise.all` inside transactions → sequential (pg 9 blocker).
10. **Escalation tiers** — vendor work-order deadlines, incident owners, one notice per
    escalation instead of daily per task. `it.fails` test S3-3.
11. **Finance overview N+1** and fewer round trips per page. `it.fails` perf test.
12. **DataTable v2** — URL state, server pagination, mobile cards, saved views; template-builder
    numeric inputs that accept Arabic digits.
13. **Import Studio polish** — skip instruction sheets, warn on formula-looking names, keep
    `+966…` phone numbers unquoted in XLSX exports. `it.fails` tests S4-2/3/4.
14. Live messaging providers verified with real accounts; routing/ETA; vendor-submitted quotes;
    organisation logo on the portal and RSVP page; change orders allocated to budget lines.

## Known technical debt

* Prisma interactive transactions with `Promise.all` log a pg deprecation warning.
* The dev server must be restarted after `prisma generate` (stale client in memory).
* Rate limits fall back to in-memory when Redis is down (per-process, not shared).
