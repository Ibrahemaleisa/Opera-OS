# Opera

**Opera** is the parent brand. **Opera Technologies** develops Opera's operational software;
the product in this repository serves agencies and organizations that manage complex
operations — events and conferences, VIP invitations and protocol, exhibitions, booths and
pavilions. Opera's execution services (event management, protocol, exhibition production)
are a separate line of business, presented on the corporate site at `/`; the software
product lives behind `/login`.

The product is an Arabic-first (RTL, with full English) multi-tenant operations platform:
projects composed from templates, tasks and approvals, VIP delivery with an Excel Import
Studio and an offline driver PWA, digital invitations with RSVP/QR, event operations,
VIP protocol, booth production, vendors, finance, and client and vendor portals.

| Document | Contents |
|---|---|
| [PRODUCT_SPEC.md](PRODUCT_SPEC.md) | users, modules, behaviour |
| [ARCHITECTURE.md](ARCHITECTURE.md) | system shape, tenancy, authorization, jobs, frontend |
| [DATA_MODEL.md](DATA_MODEL.md) | schema overview and rules |
| [SECURITY.md](SECURITY.md) | implemented controls, PDPL notes, known gaps |
| [ASSUMPTIONS.md](ASSUMPTIONS.md) | decisions made during the build |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | phase status and precise remaining work |
| [PRODUCT_AUDIT.md](PRODUCT_AUDIT.md) | five-agent product audit: findings register, evidence, execution plan, owner decisions |

**Stack:** Next.js 16 (App Router, server actions), React 19, TypeScript, Tailwind v4 +
Radix (shadcn-style), Prisma 7 on PostgreSQL 16 with row-level security, Redis + BullMQ
worker, ExcelJS, Zod, Vitest, Playwright.

## Quick start (local, without Docker)

Requirements: Node 22+, pnpm 10, PostgreSQL 16, Redis 7.

```bash
pnpm install
cp .env.example .env            # then set APP_SECRET (openssl rand -hex 32) and passwords

# one-time database setup (as a Postgres superuser)
psql -c "CREATE ROLE operra LOGIN PASSWORD 'operra_dev' CREATEDB;"
psql -c "CREATE ROLE operra_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'operra_app_dev';"
psql -c "CREATE DATABASE operra OWNER operra;"

pnpm db:migrate                 # migrations + row-level security + grants
pnpm samples                    # synthetic Excel/CSV import files in samples/
pnpm db:seed                    # optional: synthetic "demo" agency (prints logins)

pnpm dev                        # http://localhost:3000
pnpm worker                     # second terminal: imports, sends, automations, reminders
```

`DATABASE_URL` must use the non-superuser `operra_app` role — row-level security does not
apply to superusers or table owners. `MIGRATION_DATABASE_URL` uses the owner role.

Without Redis, set `JOBS_MODE=inline` and skip the worker (jobs run in-process).

### Demo logins (after `pnpm db:seed`)

Password: `Opera-Demo-2026` (local demo only; override with `SEED_PASSWORD`).

| Email | Role | Lands on |
|---|---|---|
| owner@opera.demo | Agency owner | `/o/demo` (Operations: decisions waiting, exceptions, next events) |
| director@opera.demo | Ops director (approves campaigns and finance) | `/o/demo` |
| pm@opera.demo | Project manager | `/o/demo` (scoped to their projects) |
| lead@opera.demo / staff@opera.demo | Team lead / employee | `/o/demo/my-work` |
| agent1@opera.demo / agent2@opera.demo | Field delivery agents | `/field/demo` (open on a phone) |
| client@opera.demo | Client approver | `/portal/demo` |
| vendor@opera.demo | Vendor | `/vendor/demo` |

All demo names, organisations and numbers are fictional. `pnpm db:reset-demo` removes the
demo agency (development only).

## Tests

```bash
createdb -O operra operra_test      # once; tests migrate it automatically
pnpm typecheck && pnpm lint
pnpm test                           # unit + integration (Vitest, real Postgres with RLS)
pnpm test:e2e                       # Playwright; starts `pnpm dev` unless E2E_BASE_URL is set
```

E2E runs register agencies repeatedly; set `RATE_LIMIT_MULTIPLIER=50` in `.env` for local
runs (ignored in production). Run the worker alongside the dev server for E2E. Don't run
`next build` into the same `.next` directory while `next dev` is running.

## Deploy with Docker Compose

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, APP_DB_PASSWORD, APP_SECRET, APP_URL, COOKIE_SECURE=true
docker compose up -d --build
docker compose --profile tools run --rm tools pnpm db:seed   # optional demo data
```

Services: `postgres` (creates the least-privilege `operra_app` role on first start),
`redis`, `migrate` (one-shot: migrations + RLS), `app` (Next.js standalone, port 3000,
health at `/api/health`), `worker`. Put a TLS-terminating reverse proxy in front and set
`COOKIE_SECURE=true`. For production files use S3-compatible storage
(`STORAGE_DRIVER=s3`, `S3_*`); the default local driver stores files on the `storage`
volume shared by app and worker.

The Compose file was validated (`docker compose config`) and the standalone server was
run, but the images were not built in the development environment (no Docker daemon).

### Messaging providers

Out of the box every channel runs in **simulation** mode: messages are rendered, recorded
and marked as simulated, and nothing leaves the system. To go live, set the provider
credentials (`SMTP_URL`, `UNIFONIC_*`, `WHATSAPP_*` incl. an approved template name) and
switch the channel to LIVE under *Settings → Providers*. Point delivery-receipt webhooks
at `/api/webhooks/unifonic` (`WEBHOOK_SECRET_UNIFONIC`) and `/api/webhooks/whatsapp_cloud`
(`WHATSAPP_APP_SECRET`, plus `WHATSAPP_VERIFY_TOKEN` for Meta's subscription check). SMTP
has no receipt webhook; email stays at "sent". See
IMPLEMENTATION_PLAN.md: the live adapters still need verification with real accounts.

**Notification and account e-mail (SMTP).** In-app notices that call for e-mail (approvals,
escalations, handovers, security notices; BUSINESS_RULES §3) go through an outbox with retries
(1 m, 5 m, 30 m, 2 h, then DEAD) and are listed under *Settings → Providers → Delivery log*. To send
them for real:

1. Set `SMTP_URL` (e.g. `smtps://user:password@smtp.example.com:465`, or `smtp://…:587` with
   STARTTLS) and `EMAIL_FROM` (e.g. `Opera <no-reply@your-domain>`; SPF/DKIM for that domain are
   your mail provider's setup). `APP_URL` must be the public URL: it builds the links in e-mails.
2. Switch the organisation's **Email** channel to LIVE under *Settings → Providers*. Account mail
   (password reset, "password changed", MFA notices) needs only `SMTP_URL`.

Without SMTP, or with the channel in simulation, every e-mail ends **Simulated**: recorded, never
sent and never shown as sent. Outside production a simulated password-reset link is printed to the
server console (and nowhere else) so the flow can be tried locally. Where data residency applies,
the e-mail provider's region is part of BUSINESS_RULES §9 (e-mails never contain VIP contact data).

### Scheduler: run it at least every 5 minutes

Reminders, the escalation ladders (tasks, approvals, vendor work orders, unacknowledged incidents,
deliveries near a campaign deadline), stalled-work recovery, scheduled sends and e-mail retries all
run on the scheduler tick. **Production MUST tick at least every 5 minutes** (BUSINESS_RULES §0,
§7.4): the 15-minute critical-incident escalation and the 1-minute e-mail retry are not met
otherwise. Ticks are idempotent and bounded, so calling more often is safe, and a late tick still
fires every tier it missed — once, late. Options:

* the worker (`JOBS_MODE=queue` + `pnpm worker`) ticks every 5 minutes by itself;
* an external scheduler calling `GET /api/cron/scheduler` with `Authorization: Bearer $CRON_SECRET`
  every 5 minutes;
* Vercel Cron on a plan that allows a `*/5 * * * *` schedule.

System health shows a warning when the last tick is older than 15 minutes and critical after 60.

## Deploy on Vercel

The app runs on Vercel with Neon Postgres and a **private** Vercel Blob store:

1. Create the Vercel project from this repo (framework Next.js; `vercel.json` sets the build
   command `pnpm vercel-build`, which runs migrations + RLS, an optional seed, then `next build`).
2. Storage → create a Neon database and a private Blob store, both connected to the project.
   Neon injects `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (owner role); Blob injects
   `BLOB_READ_WRITE_TOKEN`.
3. Environment variables: `APP_SECRET`, `APP_DB_PASSWORD` (the build creates the
   NOBYPASSRLS role `operra_app` with it and the app connects as that role — it refuses to serve
   on a role that bypasses RLS), `CRON_SECRET`, `JOBS_MODE=inline`, `STORAGE_DRIVER=vercel-blob`,
   `COOKIE_SECURE=true`, `MAX_UPLOAD_MB=4`; optionally `SEED_DEMO=true` + `SEED_PASSWORD`.
4. Run functions in the database's region (`regions` in `vercel.json`; this deployment's Neon
   database is in `iad1`). Each tenant transaction is several round trips, so a cross-region
   database makes every page seconds slower — `/api/health` reports `dbRoundTripMs`.

Differences from the Docker setup: there is no long-running worker — jobs run inside the
request, and the Vercel Cron in `vercel.json` (`/api/cron/scheduler`) is daily because of the Hobby
plan limit — **that does not meet the ≤ 5-minute tick production needs** (see "Scheduler" above):
use a plan that allows `*/5 * * * *` or an external scheduler with `CRON_SECRET`; without Redis,
rate limits are per function instance; uploads are limited to ~4 MB.

## Corporate site

`/` is Opera's public website (route group `src/app/(site)`); the operations workspace lives
behind `/login` as before, and signed-in visitors get a "Workspace" link that routes each role to
its own dashboard. Only `/` and `/work/*` are indexable.

Content is kept in three files, and nothing is published that isn't in them:

| File | What to supply |
|---|---|
| `src/content/company.ts` | contact email, phone and address; leadership titles and portraits (`/public/leadership/…`). `null` shows a marked placeholder. |
| `src/content/work.ts` | real, approved projects (images under `/public/work/<slug>/`). Each gets a page at `/work/<slug>`; while empty the section says the selection is being prepared. |
| `src/content/site-copy.ts` | all Arabic and English copy of the site. |

## Project layout

```
prisma/            schema, migrations, RLS SQL, seed
scripts/           apply-rls, sample generator, reset-demo
samples/           synthetic import files (generated)
src/app/           routes: (auth), o/[org], field/[org], portal/[org], vendor/[org], rsvp, account, api
src/components/    design system and module UI
src/lib/           i18n, formatting, phone, CSV safety, offline store
src/server/        db/tenancy, auth, authz, jobs, domain modules
src/worker/        BullMQ worker
tests/             unit, integration, e2e
docker/            Postgres init (runtime role)
```
