# Opera — Data model

Source of truth: `prisma/schema.prisma` (87 models, PostgreSQL 16). Migrations live in
`prisma/migrations/`; row-level security in `prisma/sql/rls.sql`. This document explains
the shape and the rules the schema alone doesn't show.

## Conventions

* **Tenant column.** Every tenant-owned table has a non-null `organizationId`. RLS is
  enabled *and forced* on all of them; the policy compares it to
  `current_setting('app.org_id')`, which the app sets per transaction (`withTenant`).
* **IDs** are CUIDs (`String @id @default(cuid())`). Human-facing codes are separate
  columns: `Project.code` (`PRJ-2026-001`), `Task.number` (per project), `Recipient.code`
  and `Delivery.code` (per project), `RFQ.code` / `PurchaseOrder.code` / `ChangeOrder.code`
  (per organization and year, e.g. `PO-2026-0007`, allocated under an advisory lock).
* **Money** is `Decimal(14,2)`; VAT is stored as a separate amount. Currency is per
  project (default SAR); no FX conversion.
* **Time** is stored in UTC (`timestamptz` via Prisma `DateTime`) and displayed in
  `Asia/Riyadh`, Gregorian or Hijri (Umm al-Qura).
* **Optimistic concurrency.** `Task.version`, `Delivery.version` (and compare-and-set
  updates on status columns elsewhere) reject stale writes with `409 conflict`.
* **Soft delete / anonymisation.** Recipients have `deletedAt` and `anonymizedAt`;
  attachments have `deletedAt`. Audit events are never deleted by the app role.

## Global (no RLS)

| Model | Purpose |
|---|---|
| `User` | login identity (email, Argon2id hash, locale, calendar, lockout counters) |
| `Session` | DB session; `id` = SHA-256 of the cookie token, sliding expiry, device label, revocation |
| `PublicToken` | hashed tokens for invitations and RSVP links → `(organizationId, kind, refId)` |
| `MessageRef` | `provider:providerMessageId` → org + `MessageJob`, so signed webhooks can find their tenant |
| `Permission` | permission catalog |

## Organization

`Organization` (profile, branding colour, `settings` JSON: `financeApprovalThreshold`,
`recipientRetentionDays`), `Role` (system or custom; permission array), `Membership`
(user ↔ org with role; `clientId` for client users, `vendorId` for vendor users),
`Invitation`, `Department`, `Team`/`TeamMember`, `ResourceProfile` (kind, daily capacity,
skills, territories, vehicle), `Client`/`Contact`, `Venue`, `CustomFieldDefinition`/
`CustomFieldValue`, `AuditEvent` (append-only for the app role), `Notification`,
`NotificationPreference`, `SavedView` (schema only — see IMPLEMENTATION_PLAN).

## Projects and templates

* `Project` — type, status, priority, client, dates, `budgetAmount` (cost plan),
  `contractValue` (revenue), `clientPortal` flag. `ProjectMember` carries the project
  role and capability flags (`canViewFinance`, `canViewVip`, `canExport`, `canApprove`)
  plus an optional `workstreamIds` restriction. `ProjectVenue`, `Risk`, `Milestone`,
  `Deliverable`, `ChangeRequest` (client → agency).
* `Template` → `TemplateVersion` (immutable JSON definition validated by Zod in
  `templates/definition.ts`) → `TemplateInstance` (which version was applied to which
  project, with the key prefix used). Applying a template materialises `Workstream`s,
  tasks, milestones, deliverables, custom fields, budget lines and operational records
  (campaigns, events with a default readiness checklist, booths/pavilions).
* `Workstream.statuses` (JSON) defines per-workstream task statuses mapped to fixed
  categories (`TODO`, `ACTIVE`, `BLOCKED`, `REVIEW`, `DONE`), so analytics stay comparable.

## Tasks, approvals, files

`Task` (number, workstream, status + category, owner, dates, estimate, recurrence,
`clientVisible`, version), `TaskCollaborator`, `TaskDependency` (cycle-checked),
`TaskAssignmentHistory`, `Checklist`/`ChecklistItem`, `Comment` (internal/client
visibility, mentions), `Attachment` (polymorphic `entityType/entityId`, storage key,
SHA-256, size, MIME from magic bytes, version chain, `clientVisible`), `Approval` +
`ApprovalDecision` (polymorphic over TASK, DELIVERABLE, MILESTONE, DESIGN_REVISION,
CAMPAIGN, PURCHASE_ORDER, EXPENSE, CHANGE_ORDER; `approverType` INTERNAL or CLIENT).

## VIP physical delivery

* `InvitationCampaign` (type PHYSICAL or DIGITAL), `Recipient` (project-scoped registry;
  names, honorific, tier, mobile in E.164, address, geo, custom fields, verification
  status, retention), `ImportMapping` (saved column mappings by header signature),
  `ImportBatch` (file hash, sheet, header row, mapping, options, status machine
  `UPLOADED → PARSED → VALIDATING → VALIDATED → COMMITTING → COMMITTED | PARTIALLY_COMMITTED | FAILED | ROLLED_BACK | CANCELLED`),
  `ImportRow` (raw + normalised values, issues, duplicate candidate, resolution).
* `Delivery` — one per `(campaign, recipient)` (unique), status (10-state machine in
  `delivery/state-machine.ts`), agent, batch, priority, window, version.
  `DeliveryEvent` (history; `clientMutationId` unique per org for offline replay),
  `DeliveryAttempt`, `DeliveryAssignment`, `DeliveryEvidence`, `DeliveryBatch`.

## Digital invitations

`ProviderConfig` (per channel: SIMULATION or LIVE), `DigitalInvitation` (address,
status, RSVP status, QR code, check-in), `MessageJob` (rendered message, provider,
`simulated` flag, `idempotencyKey`, attempts), `RSVP`, `SuppressionEntry` (opt-outs and
bounces per channel/address), `WebhookReceipt` (unique per `(organizationId, provider, externalId)`).

## Events, protocol, production

* Events: `Event` (phase), `EventSession`, `Speaker`, `RunOfShowItem` (one `GO` cue at a
  time), `Shift`, `ReadinessItem`, `Incident` (severity, status flow, escalation level,
  resolution), `LogisticsItem`.
* Protocol: `Guest` (optionally linked to a `Recipient`; category, protocol level 1–5,
  attendance state machine, seat, `restrictedNotes` — never returned by list queries),
  `SeatingZone` (capacity, minimum protocol level), `ProtocolAssignment` (escort,
  checkpoint, transport).
* Booths: `Booth` (12-stage `BoothStage`, permit, dates, handover sign-off),
  `DesignRevision` (numbered; approval-gated), `BOQItem` (estimate = qty × unit cost,
  committed, actual), `Inspection`, `Snag`.

## Vendors and finance

`Vendor` (category, CR/VAT, status, rating recomputed from accepted work orders), `RFQ`
(invited vendor ids), `Quote` (REQUESTED placeholder per invited vendor, then RECEIVED/
ACCEPTED/REJECTED), `PurchaseOrder` (`DRAFT → PENDING_APPROVAL → APPROVED → ISSUED →
PARTIALLY_RECEIVED → RECEIVED → CLOSED`), `WorkOrder` (vendor-side and agency-side
transitions, rating, on-time), `Budget` (per project + category), `Expense` (evidence via
attachments; approval required), `ChangeOrder` (contract and cost deltas).

**Derived figures are never stored**: planned/committed/actual/forecast, margin, vendor
performance, readiness %, delivery KPIs and portal progress are computed from records
at read time (`finance/service.ts`, `vendors/service.ts`, `delivery/analytics.ts`, …).

## Automation

`OutboxEvent` (written in the same transaction as the change that caused it),
`AutomationRule` (trigger, conditions JSON, actions JSON, enabled), `AutomationExecution`
(unique `idempotencyKey = rule:event`, status, attempts, error).

## Tenant-integrity note

Foreign keys reference ids only; cross-tenant references are prevented because every
parent lookup runs under RLS (a foreign tenant's row is invisible, so services raise
`NotFound`). Composite `(organizationId, id)` foreign keys would add a second line of
defence and are listed in IMPLEMENTATION_PLAN.md.
