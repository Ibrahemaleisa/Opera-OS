# Operra Events OS — Implementation plan & status

Status as of the current `claude/operra-events-os` branch. "Done" means implemented,
reachable in the UI, and covered by at least one automated test (unit, integration or
E2E) — not merely scaffolded.

## Test inventory

| Suite | Command | Coverage |
|---|---|---|
| Unit (3 files) | `pnpm test:unit` | phone normalisation, import normalisation, pure logic (state machine, templates, CSV safety, health, recurrence …) |
| Integration (7 files) | `pnpm test:integration` | tenancy/RLS, projects+templates+tasks+approvals, delivery import→commit→field, digital campaigns+webhooks+RSVP, events+protocol, booths+vendors+finance, portal+reports+automation+account |
| E2E (5 specs) | `pnpm test:e2e` | the 16-step acceptance scenario, digital campaign, events/protocol, production/finance, smoke render of every org page |

Last full run: 56/56 unit+integration tests passing; all 5 Playwright specs passing
against `next dev` with the worker running.

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

## Partial or not implemented (precise remaining work)

Ordered by suggested priority. Each item names where the work goes.

1. **Password reset and email verification** — not implemented.
   Add `PublicTokenKind.PASSWORD_RESET` / `EMAIL_VERIFY`, routes `(auth)/forgot` and
   `(auth)/reset/[token]`, services in `src/server/modules/auth/service.ts` reusing
   `issue…Token`/`hashPassword`/`revokeAllSessions`, send via the email provider
   (simulation when SMTP is unset), rate-limit per email and IP.
2. **Multi-factor authentication** — not implemented. TOTP secret on `User` (encrypted with
   `APP_SECRET`-derived key), enrolment in `/account`, second step in `login`, recovery codes.
3. **Email notifications and digests** — preferences store `email`/`digest`, but nothing
   sends them. Add a `notification.email` job in `src/server/jobs/handlers.ts` triggered from
   `notify()` when the preference allows, and a daily/weekly digest in `scheduler.ts`.
4. **Live messaging providers verification** — `SmtpProvider`, `UnifonicSmsProvider`,
   `WhatsAppCloudProvider` (`src/server/modules/digital/providers.ts`) follow the public API
   docs but were never exercised with real credentials. Verify request/response shapes,
   Unifonic delivery-report payload and signature header, WhatsApp template parameter
   mapping, and add contract tests with recorded fixtures.
5. **Automation rule builder** — rules can be enabled/disabled and inspected, not edited.
   Add a form over `actionsSchema`/`conditionsSchema` (`automation/rules.ts`) in
   `settings/automation`, with validation and a dry-run against recent outbox events.
6. **Saved views** — `SavedView` model exists; no UI. Persist filters/columns of the
   project portfolio, task list and delivery table (`DataTable` already exposes state).
7. **Retention enforcement** — anonymisation is on demand (`anonymizeRecipients`). Add a
   scheduler step that anonymises recipients past `retentionUntil` / org retention days,
   audited, plus a DSAR export of one person's records.
8. **Expense submission for non-finance staff** — the service allows project operators to
   submit expenses and attach evidence, but the only UI is the finance page (finance scope
   required). Add a "Submit expense" entry on *My work* / task detail.
9. **Template-defined dashboards** — `TemplateDefinition.dashboards` is validated but not
   rendered. Render the declared widgets on the project overview.
10. **Defence in depth** — composite `(organizationId, id)` foreign keys for parent/child
    tables; Content-Security-Policy with nonces; upload malware scanning hook
    (`files/upload.ts`); move `Promise.all` inside interactive transactions to sequential
    awaits (pg deprecation warning; works on pg 8).
11. **Branding** — org logo upload (`Organization.logoKey` exists) for the client portal and
    RSVP page; currently only the brand colour is used.
12. **Change orders vs budget lines** — approved `costDelta` is added to the planned total
    only; allocate it to a chosen budget category.
13. **Routing/ETA** — dispatch has no route optimisation or ETA (no provider configured);
    navigation uses map deep links.
14. **Vendor-submitted quotes** — vendors can't answer RFQs from the vendor portal yet
    (agency records quotes). Add a vendor quote form scoped to invited RFQs.
15. **Docker image build verification** — `docker compose config` validates, and the
    standalone server was run successfully, but images were not built here.

## Next implementation step

Item 1 (password reset + email verification), because without it agencies must reset
passwords manually; it also exercises the email provider path needed by item 3.

## Known technical debt

* Prisma interactive transactions with `Promise.all` log a pg deprecation warning.
* The dev server must be restarted after `prisma generate` (stale client in memory).
* Rate limits fall back to in-memory when Redis is down (per-process, not shared).
