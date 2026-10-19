# Operra Events OS — Security & PDPL notes

This describes the controls that are **implemented and tested** in this repository, then
the known gaps. Anything not listed under "implemented" should be treated as absent.

## Threat model in one paragraph

Operra stores VIP guest lists (names, honorifics, mobile numbers, addresses), protocol
notes, client contracts and financial records for several agencies in one database.
The main risks are: one agency reading another's data; staff seeing more VIP data than
their job needs; clients/vendors/field agents reaching internal data; leaked or replayed
links (RSVP, files, invitations); forged provider webhooks; spreadsheet formula
injection in exports; and accidental mass messaging.

## Implemented controls

### Tenant isolation (database-enforced)
* PostgreSQL row-level security is enabled **and forced** on every table with an
  `organizationId` column (`prisma/sql/rls.sql`, re-applied by `pnpm db:migrate`).
* The application connects as `operra_app` — `NOSUPERUSER NOBYPASSRLS` (created by
  `docker/postgres/10-app-role.sh` in Compose). Migrations/seeding use the owner role.
* Every tenant query runs in `withTenant()`, which sets `app.org_id` with transaction
  scope (`set_config(…, true)`), so pooled connections can't carry another tenant's context.
* `tests/integration/tenancy.test.ts` asserts RLS covers every tenant table and that a
  second agency gets nothing back even through direct ids; each module's tests repeat a
  cross-tenant check, and the E2E acceptance scenario checks a foreign tenant gets 404.

### Authentication
* DB sessions: 32 random bytes in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` when
  `COOKIE_SECURE=true`); only the SHA-256 is stored. Sliding 30-day expiry, per-device
  list, sign-out of individual devices (`/account`).
* Passwords: Argon2id (m=19 MiB, t=2, p=1). Minimum 10 characters plus a trivial-pattern
  check. Account lockout after repeated failures.
* Password change requires the current password, is rate-limited, and revokes every
  other session. Suspending/revoking a member's last membership revokes their sessions.
* Rate limits (Redis, in-memory fallback): login per IP and per email, registration,
  invitation acceptance, RSVP submit, opt-out, password change.

### Authorization
* Permissions are checked server-side in services — never only in the UI. The same
  checks back server actions, route handlers, exports, file downloads and jobs.
* Three layers: org role → permissions; project membership with capability flags
  (finance, VIP, export, approve) and workstream restriction; record scope (freelancers
  their tasks, field agents their deliveries, clients `clientVisible` records of
  projects they belong to and whose client matches their own, vendors their work orders).
* Context is rebuilt per request, so role changes take effect on the next request.
* Inaccessible records return **404, not 403**, to avoid confirming existence.
* Four-eyes rules: bulk campaigns need `campaign.approve` by someone other than the
  requester; POs at/above the org threshold (default SAR 50,000 incl. VAT), expenses and
  change orders need `finance.approve` by someone other than the requester; snag
  verification must be by someone other than the fixer.

### VIP data minimisation
* Contact fields are masked (`•••1234`) unless the user has VIP scope; full values are
  revealed through an explicit, audited action.
* Protocol `restrictedNotes` are never returned by list queries; reading them requires
  `protocol.viewRestricted` **and** project VIP scope and writes an audit event per view.
* Client portal, reports and RSVP pages return aggregates or the minimum needed (RSVP:
  honorific + name + event). Tests assert recipient phone numbers never reach the portal.
* Audit payloads redact `passwordHash`, `mobile`, `altPhone`, `email`, `address`,
  `restrictedNotes`.

### Links, files and webhooks
* Invitation and RSVP tokens: random, stored hashed, single purpose, with expiry; RSVP
  pages are `noindex` with `Referrer-Policy: no-referrer`; opt-out needs a click (no
  state change on GET).
* Files: size limit, MIME detected from magic bytes against an allow-list, SHA-256
  stored, private storage; downloads go through a permission check and short-lived
  signed URLs (S3 presigned, or HMAC-signed local URLs); every access is audited.
* Provider webhooks are verified with HMAC-SHA256 and constant-time comparison; receipts
  are idempotent per tenant; message status never moves backwards.
* Same-origin checks on mutating route handlers; Next.js server actions enforce origin.

### Output safety
* CSV/XLSX exports neutralise formula injection (`= + - @ TAB CR` prefixed with `'`).
* Exports require `export.data` (+ project export scope where applicable) and are audited.

### Messaging
* Providers run in **SIMULATION** unless credentials exist in the environment; LIVE mode
  is refused otherwise. Simulated records are labelled everywhere. WhatsApp only via the
  official WhatsApp Business Cloud API with a pre-approved template.
* Opt-outs and bounces go to a per-channel suppression list honoured before every send.

### Platform
* Security headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`, `X-Robots-Tag: noindex`. No secrets in the
  repository; configuration via environment (`.env.example`). Container runs as non-root.

## PDPL (Saudi Personal Data Protection Law) support

Implemented: purpose-limited data per project; role-based minimisation and masking;
access logging for sensitive views and file access; per-organisation retention period
(`recipientRetentionDays`) with an **on-demand** "anonymise expired recipients" action;
opt-out handling; data stays in the deployment's own database and storage (choose a
Saudi region for production hosting).
Not implemented: automatic scheduled retention enforcement, data-subject access/export
workflow, consent records per recipient, a records-of-processing register. Agencies remain
the data controller and must configure retention and lawful basis themselves.

## Known gaps (not implemented)

* Multi-factor authentication, email verification, and a forgot-password / reset flow.
* A Content-Security-Policy header (needs nonce support for inline scripts).
* Malware scanning of uploads (only type/size checks).
* Composite `(organizationId, id)` foreign keys as defence-in-depth behind RLS.
* Automatic retention jobs and DSAR tooling (see PDPL above).
* Live provider adapters were written against the providers' public API docs but have
  **not** been exercised with real credentials; the Unifonic webhook payload shape in
  particular must be verified before going live.
* No third-party penetration test has been performed.

## Reporting

Please report suspected vulnerabilities privately to the repository owner rather than
opening a public issue.
