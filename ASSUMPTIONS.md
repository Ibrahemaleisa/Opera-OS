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
    budget line = max(planned, committed POs + expenses not tied to a PO, actual expenses), and
    the cost side of approved change orders is added on top (it is planned cost outside the
    budget lines until the budget is edited). The plan is the floor until spend proves
    otherwise, so a plan above the contract always reads as a negative margin; before this rule
    an un-procured project showed ~100 % margin. The UI also shows the *planned* margin
    (contract − plan) and how much of the plan is covered by commitments.
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
34. **Project health v2** (`projects/health.ts`) is one computation shared by the portfolio, the
    project overview and the Operations board. The schedule is anchored on the event start
    (falling back to the deadline): expected progress = share of top-level tasks whose due
    date has passed, compared with the share done, weighted ×1.5 within 21 days and ×2 within
    7 days of the anchor. Deductions (capped): overdue work (priority- and client-visibility
    weighted), unowned tasks due within 7 days, internal approvals past due, overdue or blocked
    milestones, events within 7 days below 80 % ready, forecast above plan or above contract,
    open HIGH+ incidents, blocked tasks, high risks. Client-owed approvals past due are shown
    as "client delay" with no deduction. Good ≥ 75, watch ≥ 50, else critical; a blocker
    (critical incident, overdue critical task, event readiness, forecast above contract) caps
    the level at watch and sets `atRisk`, as does a score below 60. Finance reasons count for
    every viewer but are worded without detail for viewers without finance scope.
35. **Operations board ("Today")** lists exceptions only from projects that are not closed,
    cancelled, completed or on hold, scoped like the portfolio (PMs see their projects).
    An approval without its own due date is due 48 h after the request. Unowned work shows
    when due within 14 days (within 3 days it is highlighted). Deliveries are an exception
    when not yet out with less than 48 h to the campaign deadline. Money exceptions appear only
    for projects the viewer has finance scope on. Team leads, employees and freelancers land
    on My work instead of the board.
