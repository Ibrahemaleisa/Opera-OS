# Opera — Security & PDPL notes

This describes the controls that are **implemented and tested** in this repository, then
the known gaps. Anything not listed under "implemented" should be treated as absent.

## Threat model in one paragraph

Opera stores VIP guest lists (names, honorifics, mobile numbers, addresses), protocol
notes, client contracts and financial records for several agencies in one database.
The main risks are: one agency reading another's data; staff seeing more VIP data than
their job needs; clients/vendors/field agents reaching internal data; leaked or replayed
links (RSVP, files, invitations); forged provider webhooks; spreadsheet formula
injection in exports; and accidental mass messaging.

## Implemented controls

### Tenant isolation (database-enforced)
* PostgreSQL row-level security is **enabled** on every table with an `organizationId`
  column (`prisma/sql/rls.sql`, re-applied by `pnpm db:migrate`). It is deliberately *not*
  `FORCE`d: the policies bind the runtime role, which is neither superuser, `BYPASSRLS` nor
  the table owner (checked at start-up in production, `src/server/db/client.ts`). The owner
  role — migrations, seed, test fixtures and the scheduler's cross-tenant discovery — is
  exempt by design; forcing RLS would break those paths.
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
  invitation acceptance, RSVP submit, opt-out, password change, password-reset requests
  (3 per e-mail and 10 per IP per hour), MFA codes.
* Password recovery (`/forgot`, `/reset/[token]`, `src/server/modules/auth/password-reset.ts`,
  BUSINESS_RULES §5.1): the request always gets the same response and the work runs after the
  response (no account enumeration by content or timing); over a limit nothing is sent. The link
  carries 32 random bytes; only its SHA-256 is stored (`PublicToken` `PASSWORD_RESET`), it expires
  after 30 minutes, works once (compare-and-set) and a newer request voids older links. The link is
  rendered into one e-mail and never persisted (`SystemEmail` keeps no secret), so a failed send is
  not retried: the user asks again. Completing a reset sets a new Argon2id hash and
  `passwordChangedAt`, revokes every session and pending MFA challenge, clears the lockout, does
  not sign in, and sends "your password was changed". The reset page is `noindex` with
  `Referrer-Policy: no-referrer`. Admins can send a reset link (`member.reset_link_sent`) without
  ever seeing it. Audit `auth.password_reset_requested` / `_completed` in every organisation of the user.
* Two-step verification (`src/server/auth/totp.ts`, `src/server/modules/auth/mfa*.ts`, §5.2): TOTP
  per RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step) on `node:crypto`; the secret is encrypted at rest
  with AES-256-GCM under a key derived from `APP_SECRET` (HKDF-SHA256). Replay protection: a code's
  time step must be newer than the last accepted one (`mfaLastStep`, compare-and-set). Enrolment
  re-asks the password and confirms one code; 10 one-time recovery codes are shown once and stored
  as SHA-256. With MFA on, the password alone creates **no session**: an `MFA_CHALLENGE` token
  (HttpOnly cookie, 5 minutes) is consumed by every attempt; 5 wrong codes end it and every wrong
  code counts toward the account lockout. A recovery-code sign-in e-mails the account. Turning MFA
  off needs the password and a current code and is refused while an organisation requires it for
  the role. Admin reset (owner, or director for non-owners, never oneself, with a reason) clears MFA
  and revokes every session; refused when the person also belongs to another organisation. An
  existing account with MFA accepting an invitation signs in through both steps.
* Organisation MFA policy (Settings → Security, owner only, audited `org.mfa_policy`, stored in
  `Organization.settings.security`): required for privileged roles (any role with `org.manage`,
  `org.members.manage`, `org.roles.manage`, `finance.approve`, `campaign.approve` or
  `automation.manage`; optionally `vip.viewSensitive`), on by default for new organisations. Each
  covered member has 14 days from the policy or their privileged role; after that their session is
  enrolment-only in that organisation: pages redirect to `/mfa-setup`, server actions and route
  handlers are refused (`src/server/request.ts`, fail-closed). Step-up MFA for individual actions is
  not in Milestone 2.

### Authorization
* Permissions are checked server-side in services — never only in the UI. The same
  checks back server actions, route handlers, exports, file downloads and jobs.
* Three layers: org role → permissions; project membership with capability flags
  (finance, VIP, export, approve) and workstream restriction; record scope (freelancers
  their tasks, field agents their deliveries, clients `clientVisible` records of
  projects they belong to and whose client matches their own, vendors their work orders).
* Every page states its surface (`requirePageContext(slug, "workspace" | "portal" | "vendor" | "field")`);
  a role that doesn't fit is sent to its own home. The gate is in the page, not only the layout,
  because a layout redirect doesn't stop a page segment from rendering (RSC partial rendering).
  Org-level boards (portfolio, command center, arrivals, dashboard, search, reports) also return
  nothing to client, vendor and field roles (`projectVisibilityWhere`).
* A client contact's project access requires the project's client to be their own client company;
  re-assigning a project to another client ends the previous client's access.
* Context is rebuilt per request, so role changes take effect on the next request. Only an owner
  can change or suspend an owner, and nobody can change their own role or status.
* Departure (`src/server/modules/org/handover.ts`, BUSINESS_RULES §2): suspending or revoking a member
  runs the handover in the same transaction — tasks, designated approvals, incidents, readiness items,
  snags, risks, cues, shifts and escorts go to an eligible active internal replacement or are left
  visibly unowned. A designated approval moves only to someone who may decide it; otherwise it returns
  to the eligible pool, or is cancelled with revert when nobody else can decide. The last active PM of
  a live project can't leave without a replacement holding `project.manage` (`errors.lastManager`).
  REVOKED is final (re-invite instead); reactivating a suspended member hands nothing back. Suspending
  an owner is told to the other owners.
* Project lifecycle (`src/server/modules/projects/lifecycle.ts`, §1): only the transitions of §1.2;
  cancel, close and reopen need `project.delete`. Cancelled and closed projects are read-only
  (`ProjectScope.archived`: `operate`/`manage` false, `errors.projectArchived`) except the financial
  tail (PO receive/close/cancel, expense and change-order decisions, payment) and the incident tail.
  The cancel cascade runs in the status change's transaction. Closing with unmet gates is an audited
  override (`project.close_override`) that needs a reason and, for open POs, expenses or work orders,
  `finance.approve`. Clients see archived projects read-only for 180 days and make no decisions there.
* Concurrent edits: project, milestone, risk, deliverable and budget-line updates and every project
  status change are a compare-and-set on the loaded `version`; a missing version is refused and a
  stale one returns 409 with the current values (§6).
* Inaccessible records return **404, not 403**, to avoid confirming existence.
* Approvals (`src/server/modules/approvals/service.ts`, one rule `mayDecide` for deciding, the
  approver list and "awaiting you"):
  * the decider is never the requester; for POs, expenses and change orders also never the person
    who created/submitted the spend;
  * authority is by type — campaigns `campaign.approve`; POs at/above the org threshold (default
    SAR 50,000 incl. VAT), expenses and change orders `finance.approve` with project finance scope;
    tasks, deliverables, milestones and design revisions project approve scope; client approvals a
    client approver of the project's client. Naming an approver narrows the set, never grants authority;
  * at request time the eligible approver set is resolved and notified; an empty set refuses the request
    (`errors.noEligibleApprover`); a request without a due date is due after the org SLA (default 48 h);
  * separation of duties (§4): under the default STANDARD policy the performer may decide a request
    someone else made; under STRICT (org setting, owner only, audited `org.approval_policy`) or on a
    project flagged `independentApprovalRequired` (set by `project.delete`, cleared only with a reason)
    the performer never decides — task owner and collaborators, deliverable uploaders and submitter,
    owners of the milestone's workstream tasks, campaign author and editors since the last approval,
    revision author and uploaders;
  * small-organisation exception (§4.3, off by default, one owner-only toggle; optional end date, type
    scope, spend cap ≤ SAR 250,000 and audience cap ≤ 500 under "Advanced"): when nobody else can
    decide, the requester may approve their own request with a one-line note. Never for
    client approvals, flagged projects or designated approvers; recorded as `policyException`, audited
    `approval.self_approved`, told to every other owner and listed on the Operations home for 30 days;
  * decisions compare-and-set the entity's expected state (a changed entity makes the request stale);
    a requester or project manager can withdraw a pending request (reason required, audited);
    reopening approved work marks the approval SUPERSEDED, so it must be approved again;
  * campaign content and audience are frozen from the approval request until sending: an edit voids
    the approval and returns the campaign to draft. Scheduled campaigns are released by the scheduler
    only when due (also without a worker).
* Snag verification must be by someone other than the fixer.

### VIP data minimisation
* Contact fields are masked (`•••1234`) for users without VIP scope — registry, delivery
  lists, import review and the import error report included; org-wide duplicate matches in
  another project are reported without name, code or number. Users with VIP scope see contact
  data in lists; explicit reveals and every export are audited (list views are not).
* Protocol `restrictedNotes` are never returned by list queries; reading them requires
  `protocol.viewRestricted` **and** project VIP scope and writes an audit event per view.
* Client portal, reports and RSVP pages return aggregates or the minimum needed (RSVP:
  honorific + name + event). Tests assert recipient phone numbers never reach the portal.
* Audit payloads redact `passwordHash`, `mobile`, `altPhone`, `email`, `address`,
  `restrictedNotes`.

### Links, files and webhooks
* Invitation and RSVP tokens: random, stored hashed, single purpose, with enforced expiry
  (RSVP: a week after the later of the RSVP deadline and the event end, 90 days if neither;
  an expired link shows nothing and accepts no response, but still accepts an opt-out); RSVP
  pages are `noindex` with `Referrer-Policy: no-referrer`; opt-out needs a click (no
  state change on GET). Post-login redirects accept only same-origin relative paths.
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
* Notification e-mail (BUSINESS_RULES §3): `notify()` writes the in-app notice and, when the type
  and the recipient's preference call for it, a `NotificationDelivery` row in the same transaction;
  it is sent after commit (request `after()`, the worker, or the scheduler) with a compare-and-set
  claim, so two senders never send the same row. Retries back off 1 m, 5 m, 30 m, 2 h; the 5th
  failure, or a permanent 5xx, is DEAD and listed in Settings → Providers → Delivery log with a
  manual, audited retry. Recipients are active members only; addresses are masked in the log.
  E-mails carry the notice title, code, count and a deep link, never VIP contact data, protocol
  notes or amounts, and every value is HTML-escaped. Mandatory types (approvals, escalations,
  handover, security) can't be switched off.
* E-mail **simulation** is explicit: without `SMTP_URL`, or while the organisation's e-mail
  channel is SIMULATION, deliveries end `SIMULATED` — rendered and recorded, never sent and never
  shown or counted as sent (the delivery log and the preference table say "simulated"). Account
  mail (reset links, security notices) is `SystemEmail`; outside production a simulated reset link
  is printed to the server console only.

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

* E-mail address verification at registration; step-up MFA for sensitive actions; WebAuthn /
  passkeys; bounce and complaint webhooks for notification e-mail (SMTP `SENT` means accepted by
  the server, not read).
* MFA reset for a person who belongs to several organisations needs an Opera support process
  (the product refuses it).
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
