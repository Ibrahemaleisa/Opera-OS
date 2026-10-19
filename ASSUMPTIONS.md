# Assumptions & decisions

Decisions made autonomously; each can be revisited.

## Product
1. **Tenant = agency.** Clients and vendors are users with memberships *inside* an
   agency tenant (roles `CLIENT`, `CLIENT_APPROVER`, `VENDOR`) linked to a `Client`
   or `Vendor` record — not separate tenants.
2. **Starter templates are copied into each organization** at creation (as v1).
   This keeps RLS uniform (no global tenant data) and lets each agency customize.
3. **Template instances are snapshots.** Applying a template copies the definition
   of a specific `TemplateVersion` into real workstreams/tasks/milestones. Editing
   the template creates a new version; existing projects are untouched.
4. **Composition collisions**: if two templates define the same workstream key, the
   second is suffixed (e.g. `logistics` → `logistics-2`) and both keep their own
   identity; task dependencies are resolved within the template instance only.
5. **Recipients are project‑scoped**, with optional duplicate detection against the
   whole organization registry (configurable per import).
6. **One delivery card per (campaign, recipient)** — enforced by a unique index.
7. **Delivery statuses** are the ten listed in the brief; the allowed transitions
   are defined in a state machine. Labels are configurable per org; the semantic
   keys are fixed so KPIs remain meaningful.
8. **No routing provider** is configured by default, so the dispatch center shows
   no ETA/distance; navigation uses Google Maps / Apple Maps deep links from the
   address or coordinates supplied in the import.
9. **Messaging providers** run in *simulation mode* unless credentials are present.
   Simulated sends are labelled "simulation" everywhere (UI, exports, records).
   WhatsApp is supported only through the official WhatsApp Business Cloud API
   adapter interface.
10. **Bulk outbound campaigns require approval** by a user holding
    `campaign.approve` before they can be scheduled.
11. Financial figures are stored as `Decimal(14,2)` in SAR by default; multi‑currency
    is stored per project but no FX conversion is performed.
12. VAT (15%) is captured as a separate amount on quotes/expenses; no tax engine.
13. Hijri dates use the Umm al‑Qura calendar via `Intl` (`islamic-umalqura`).

## Engineering
14. Single Next.js app + worker instead of a multi‑package monorepo: fewer moving
    parts; module boundaries are folders.
15. Authentication uses DB‑backed sessions with Argon2id instead of Auth.js (see
    ARCHITECTURE §4 / SECURITY.md for rationale).
16. The development container has no Docker daemon; local Postgres 16 and Redis
    are used directly. `docker-compose.yml` is provided for other environments.
17. When `STORAGE_DRIVER=local`, files are stored under `./storage` and served via
    an HMAC‑signed, expiring, permission‑checked route — the same contract as S3
    presigned URLs.
18. Email in development uses a console/outbox adapter (records are stored in
    `MessageJob` with `simulated = true`).
19. Saudi mobile numbers are normalized to E.164 (`+9665XXXXXXXX`); landlines are
    accepted and flagged as non‑mobile.
20. All demo data is synthetic (fictional names/organizations generated from word
    lists). No real VIP identities.

## Added during phases 4–7
21. **Template-created digital campaigns** default to SMS with an Arabic/English body
    containing `{{rsvp_link}}` and `{{opt_out_link}}`; changing a campaign's channel
    re-derives every unsent invitation's address and suppression state.
22. **Expenses always need approval** (evidence required, approver ≠ requester); **purchase
    orders need approval only at or above** the organisation threshold (default SAR 50,000,
    *including* VAT) — below it they are approved directly and the decision is audited.
23. **Contract value** (revenue) is a separate field from the project budget (cost plan).
    Margin = (contract + approved change-order amounts) − forecast cost, where forecast per
    budget line = max(committed POs + expenses not tied to a PO, actual expenses).
24. **Awarding a quote that is not the lowest** requires a written justification; awarding
    creates a *draft* PO that still follows the PO approval rule.
25. **Booth stage gates** are cumulative: moving forward checks every gate up to the target
    stage; moving back is always allowed but requires a reason (audited).
26. **Snags, change orders and campaigns follow four-eyes rules**; snags must be verified by
    someone other than the person who marked them fixed.
27. **Client contacts can join only projects whose client matches their linked client.**
    Client "approved progress" counts only client-visible tasks in a DONE category; tasks in
    internal review are listed as upcoming.
28. **One live cue** per event run of show: setting a cue to GO completes the previous one.
29. **Restricted protocol notes** are write-only for users without `protocol.viewRestricted`;
    editing a guest without that permission never overwrites existing notes.
30. **Vendor users** see only work orders of the vendor linked to their membership and can
    move them ISSUED → ACCEPTED → IN_PROGRESS → DELIVERED; the agency accepts and rates.
    On-time means the vendor marked it delivered by the due date.
31. **Document codes** (`PO-`, `RFQ-`, `CO-`) restart each year (Asia/Riyadh) per organisation.
32. **Reports** never include recipient or guest personal data; personal-data exports stay
    in-project (delivery export, guest list) behind export and VIP scope.
33. Notification email/digest preferences are stored but **not sent** yet (in-app only).
