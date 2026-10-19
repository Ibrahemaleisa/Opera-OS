# Operra Events OS — Architecture

## 1. Shape of the system

Operra is a **modular monolith**: one Next.js (App Router) application that serves
the agency workspace, the field (driver) PWA, the white‑labeled client portal and
the public RSVP pages, plus **one background worker process** that consumes BullMQ
queues. Both processes share the same TypeScript modules under `src/server`.

```
                ┌──────────────────────────── Next.js app (src/app) ────────────────────────────┐
 Browser ──────▶│ /o/[org]/…  agency workspace   /o/[org]/field  driver PWA                      │
 (RTL / LTR)    │ /portal/[org]/… client portal  /rsvp/[token]   public RSVP   /api/* route hdlrs │
                └──────────────┬───────────────────────────────────────────────┬────────────────┘
                               │ server actions / route handlers                │ enqueue
                               ▼                                                ▼
                ┌──────── src/server (domain modules) ────────┐        ┌──── Redis / BullMQ ────┐
                │ auth · authz · tenancy · audit · files      │        │ imports · messages ·   │
                │ org · projects · templates · tasks          │◀──────▶│ automation · reminders │
                │ delivery (imports, dispatch, field) ·       │        └───────────┬────────────┘
                │ digital · events · protocol · booths ·      │                    │
                │ vendors · finance · automation · analytics  │        ┌───────────▼────────────┐
                └──────────────┬──────────────────────────────┘        │ worker (src/worker)    │
                               │ withTenant(orgId) → SET LOCAL          └───────────┬────────────┘
                               ▼                                                    │
                ┌──────────── PostgreSQL 16 (Row‑Level Security) ─────────────┐◀────┘
                │ runtime role `operra_app` (NOBYPASSRLS)  ·  owner `operra`   │
                └──────────────────────────────────────────────────────────────┘
                ┌──── Object storage: S3‑compatible (MinIO/S3) or local driver ────┐
                └─────────── private bucket, signed short‑lived URLs ──────────────┘
```

Why a monolith: one team, one deployable, transactional consistency across
modules (e.g. an import commit creates recipients + deliveries + audit rows in a
single transaction). Module boundaries are enforced by folder structure and by
each module exposing only its `service.ts` / `actions.ts` / `queries.ts`.

## 2. Repository layout

```
prisma/                 schema.prisma, migrations/, seed.ts
prisma/sql/rls.sql      row‑level security policies + grants (idempotent)
scripts/                apply-rls.ts, generate-samples.ts
samples/                synthetic XLSX/CSV import files (generated)
src/app/                routes (App Router)
  (auth)/               login, register, invitation acceptance
  o/[org]/              agency workspace (sidebar shell)
  o/[org]/field/        driver mobile workspace (PWA, offline queue)
  portal/[org]/         client portal (white‑labeled shell)
  rsvp/[token]/         public RSVP landing page
  api/                  files, exports, webhooks, field sync, health
src/components/ui       design‑system primitives (shadcn/ui style on Radix)
src/components/app      shell, data table, command palette, page scaffolding
src/lib                 pure utilities: i18n, formatting (SAR/Hijri), phone, csv‑safe
src/server/db           Prisma clients, tenant transaction boundary
src/server/auth         sessions, password hashing, rate limiting
src/server/authz        permission catalog, role defaults, scoped policy checks
src/server/modules/*    domain modules (service + actions + queries)
src/server/jobs         queue definitions + job handlers
src/worker              worker entrypoint
tests/unit|integration  Vitest
tests/e2e               Playwright
```

## 3. Multi‑tenancy (database‑enforced)

* Every tenant‑owned table has a non‑null `organizationId` column.
* `prisma/sql/rls.sql` enables **and forces** RLS on every such table and installs
  a policy `organizationId = current_setting('app.org_id', true)`. The script is
  generic (it discovers tables by column), idempotent, and re‑applied after every
  migration (`pnpm db:migrate`). An integration test fails if any table with an
  `organizationId` column lacks RLS.
* The runtime connects as `operra_app` (`NOSUPERUSER NOBYPASSRLS`). Migrations and
  seeds run as the owner `operra`. A forgotten `where organizationId` filter in
  application code therefore returns nothing rather than another tenant's data.
* All tenant data access goes through `withTenant(ctx, fn)` which opens an
  interactive transaction and issues `set_config('app.org_id', …, true)` (and
  `app.user_id`) — `SET LOCAL` semantics, so pooled connections never leak context.
* Pre‑tenant lookups use global tables only: `User`, `Session`, `PublicToken`
  (hashed tokens for invitations / RSVP / webhooks that map to an org), `Permission`.
* `Membership` and `Organization` additionally allow rows belonging to the current
  `app.user_id` so the org switcher works before an org is selected.
* Platform super‑admin operations use a separate owner connection that is only
  importable from `src/server/modules/platform`.

## 4. Identity & authorization

* **Authentication**: database sessions (the pattern recommended by the Lucia /
  Oslo project and OWASP): 32‑byte random token in an `HttpOnly; Secure;
  SameSite=Lax` cookie, only its SHA‑256 hash stored, sliding expiry, per‑device
  session list, revocation on role change / logout. Passwords: Argon2id
  (`@node-rs/argon2`). Login and public endpoints are rate‑limited (Redis, with an
  in‑memory fallback). Auth.js was considered; credentials + DB sessions +
  immediate revocation (needed for field devices) is awkward there, so the smaller
  audited pattern was chosen. See SECURITY.md.
* **Authorization** has three layers, all evaluated server‑side:
  1. *Org role → permission set* (`src/server/authz/roles.ts`), e.g.
     `project.create`, `finance.view`, `vip.viewSensitive`, `export.data`.
     Custom roles are rows in `Role` with a permission array.
  2. *Project scope*: users without `project.viewAll` must be a `ProjectMember`;
     the membership row carries a project role and capability flags
     (finance visibility, VIP visibility, export, approval authority) and an
     optional workstream restriction.
  3. *Record scope*: freelancers see only tasks they own/collaborate on; drivers
     see only deliveries assigned to them (and contact data only while the
     delivery is active); clients see only `clientVisible` records of their
     projects; vendors see only their work orders / RFQs.
* `ServiceContext` (user, org, membership, permissions) is built once per request
  and passed explicitly to services. Server actions, route handlers, exports,
  file downloads and jobs all call the same policy functions.

## 5. Domain modules

| Module | Responsibilities |
|---|---|
| org | org profile/branding/settings, members, invitations, teams, departments, clients, contacts, venues, custom fields |
| projects | projects, members, risks, milestones, deliverables, health score, portfolio/kanban/calendar/timeline/workload views |
| templates | template library, versioned definitions (Zod‑validated JSON), preview, composition into projects (collision resolution, prefixed keys) |
| tasks | tasks, subtasks, dependencies, checklists, collaborators, comments/mentions, approvals, recurring tasks, bulk actions, saved views |
| delivery | recipient registry, Excel import studio, delivery cards, batches, dispatch, assignments, attempts, evidence, field sync, analytics |
| digital | digital campaigns, personalization, provider adapters (simulation/live), send queue, webhooks, RSVP, suppression, QR check‑in |
| events | events, sessions, speakers, run‑of‑show, shifts, readiness, incidents, logistics, live command center |
| protocol | VIP guests, classifications, escorts, arrival/departure, seating zones, checkpoints, restricted notes (access‑audited) |
| booths | booth/pavilion production stages, design revisions + approval gates, BOQ, inspections, snags, handover |
| vendors | vendor directory, contacts, RFQs, quotes, work orders, performance |
| finance | budgets per category, POs, expenses with evidence, change orders, thresholds, planned vs committed vs actual |
| automation | outbox events → rule matching → idempotent executions (notify, create task, escalate, reopen) |
| notifications | in‑app notification center, preferences, email adapter |
| analytics | KPI queries computed from live records, exports |
| audit | append‑only audit events for all critical mutations |
| files | storage adapter (S3 / local), checksums, versions, signed URLs, permission‑checked download |

## 6. Background processing

* BullMQ queues: `imports`, `messages`, `automation`, `scheduler`.
* Jobs carry `{ orgId, actorId, … }` and re‑enter the tenant boundary with
  `withTenant`. Each job is idempotent: imports are guarded by batch status
  transitions (`compare‑and‑set` on `status`), message sends by
  `MessageJob.idempotencyKey`, automations by `AutomationExecution.idempotencyKey`.
* **Transactional outbox**: domain mutations write an `OutboxEvent` row inside
  the same transaction; the worker (or the inline dispatcher when Redis is absent)
  processes outbox rows into automation executions. No event is lost if Redis is
  down at commit time.
* When `JOBS_MODE=inline` (tests, single‑process dev), jobs execute in‑process
  through the same handlers.

## 7. Consistency & concurrency

* Critical mutations run in one transaction (import commit, bulk assignment,
  delivery status change + attempt + evidence + history + outbox).
* Delivery status changes go through an explicit **state machine**
  (`src/server/modules/delivery/state-machine.ts`) and optimistic concurrency
  (`version` column, `updateMany where version = expected`).
* Field updates from the offline queue carry a client‑generated `clientMutationId`
  (unique) → replays are no‑ops; version mismatches are returned as conflicts and
  surfaced in the driver UI.

## 8. Frontend

* React Server Components for data reads; server actions for mutations; TanStack
  Table for dense grids; TanStack Query only where client polling is required
  (dispatch refresh, import progress, field sync).
* i18n: typed dictionaries (`src/lib/i18n`), Arabic default, locale from user
  preference/cookie, `dir` set on `<html>`; logical CSS properties (`ms-`, `pe-`)
  throughout so layouts mirror correctly.
* Formatting: `Asia/Riyadh` timezone, SAR currency, Gregorian or Hijri
  (Umm al‑Qura) display per org/user setting.
* Design tokens as CSS variables (light/dark), Instrument Sans + IBM Plex Sans
  Arabic, self‑hosted via Fontsource (no third‑party font requests).

## 9. Deployment topology

* `docker-compose.yml`: postgres, redis, minio, app, worker.
* Stateless app containers; sessions in Postgres; files in object storage.
* Health check: `/api/health` (DB + Redis).
