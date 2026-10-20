# Architecture extension for BRD v1.2

Prepared 20 Oct 2026. This extends the existing design (NestJS modular monolith, Next.js web, PostgreSQL with
forced row-level security, Redis, a worker, ClamAV) and the ADRs in `docs/adr/`. No new services are introduced
until a measured need appears.

## Principles

1. **One modular monolith, one worker, one database.** New capabilities are modules (`messaging`, `crm`,
   `campaigns`, `automation`, `ai`, `commerce`, `payments`, `service-ops`), each owning its tables. A module may be
   extracted only when its load or failure isolation needs it, and that needs an ADR with measurements.
2. **Every company-owned row has `tenant_id`, forced RLS and composite `(tenant_id, id)` foreign keys.** The CI
   guard (`check-rls`) and the isolation test cover every new table automatically.
3. **Privileged database functions are rare, named and owned by a dedicated NOLOGIN role** with the narrowest
   rights (as `cf_auth`, `cf_ops`, `cf_pilot`, and now `cf_channel`).
4. **External input is untrusted:** webhooks, uploaded files, retrieved documents, customer messages and provider
   responses. None of it can grant permissions, choose a company, or instruct an AI tool.
5. **Honest state:** a record says what actually happened (queued, sent, failed, pending approval), never what we
   hope happened.

## Decisions taken in slice 1 (proposed as ADR-038 to ADR-041)

| # | Decision | Why | Revisit when |
| --- | --- | --- | --- |
| AX-1 (ADR-038) | **Channel adapters behind one interface**, starting with a sandbox adapter that never uses the network and is refused in production. Webhook payloads use Meta's documented shape, so the Cloud API adapter reuses the parser | Lets Wave 1 be built and tested before Meta onboarding; keeps the real adapter small | Meta Tech Provider approval |
| AX-2 (ADR-039) | **Webhook routing through one SECURITY DEFINER lookup** (`channel_route`) owned by `cf_channel`, which can read only the routing columns of active connections. After routing, everything runs as `cf_app` inside that company's context | A verified webhook names a number, not a company. This keeps cross-company reads to one audited lookup | — |
| AX-5 | **Provider timestamps capped at receipt time**; webhook bodies up to 3 MB on the webhook route only (larger → 413); `cf_channel` pinned by the CI guard to five routing columns and one reviewed function | Review of slice 1 (M2, M4, M5) | — |
| AX-6 | **Reply pause** stored on the conversation (who, reason, when, until or manual); enforced for replies, retries and at send time; ordinary notes never block | Owner decision 20 Oct 2026 | — |
| AX-3 (ADR-040) | **Events are recorded and applied in the same request for slice 1**, with a unique key per provider event so repeats are no-ops. Meta retries for up to 7 days and does not guarantee order, so de-duplication and order tolerance are required either way | Simplest correct start. The next slice moves *applying* to the worker (record first, acknowledge, process asynchronously), as Meta recommends for high volume | Before live traffic; before campaigns |
| AX-4 (ADR-041) | **Reply collision check by an arrival counter** (`seenActivity` must equal `conversations.activity_seq`, compared under a row lock; every recorded message bumps it, including a late customer message with an older timestamp — review M1) plus optimistic versions for assignment; replying claims an unassigned conversation; taking over needs `inbox.assign` and an explicit flag, and is audited | Two agents can never send conflicting replies without knowing; ownership is always visible | — |

## Reliable sending (built in slice 2, `138869e`)

- One `send_jobs` row per outbound message (unique), leased through `dispatch_claim` (owned by NOLOGIN `cf_dispatch`,
  which sees scheduling columns only). Each job is processed as `cf_app` inside its company's context.
- **Before** the provider call, the message is marked `submitting` and committed. Outcomes: `sent`; `failed` (definite
  refusal); back to `queued` with back-off (definitely not accepted; at most 5 attempts, then `failed` and job `dead`);
  `uncertain` (unknown outcome). A job found in `submitting` after a stop becomes `uncertain`: **never resent
  automatically**.
- Every send carries our message id as Meta's `biz_opaque_callback_data` (echoed in status webhooks — Meta status
  webhook reference, read 20 Oct 2026, page undated), so an uncertain send is settled by its status without resending.
- Conditions are re-checked at the moment of sending (opt-out, pause, channel, 24-hour window).
- A person may retry a failed message, or an uncertain one after confirming a possible duplicate; the retry is a new
  message linked to the original, at most one per original, audited.
- Inbound webhook processing stays in-request: it is idempotent and Meta retries on failure for up to 7 days.

## Reliable processing (remaining)

- **Outbox pattern.** A business change and the event announcing it are written in the same transaction
  (`outbox_events`). The worker publishes and applies them, so nothing is lost if a process stops halfway.
- **Idempotent consumers.** Every consumer records a processed key; a repeated delivery is a no-op.
- **Bounded retries with back-off**, then a **dead-letter** state visible to platform staff, with a **controlled
  replay** that is permission-checked and audited.
- **Outbound sends.** A message is recorded as `queued` before sending. Slice 1 sends in the request; the next slice
  moves sending to the worker, retries transient failures with the same idempotency key, and resolves any message
  left `queued` after a crash.
- **Timeouts and circuit breakers** around each provider, with provider health shown to owners and platform staff.

## State machines (explicit, stored, tested)

| Object | States | Notes |
| --- | --- | --- |
| Outbound message | queued → sent → delivered → read; any → failed | Forward-only (slice 1 enforces this for statuses) |
| Conversation | open ⇄ pending → resolved; reopened by a new customer message as a new conversation | One unresolved conversation per contact and channel |
| Assignment | unassigned → assigned(person) → reassigned / taken over / released | Every change is a conversation event |
| Workflow run | pending → running → waiting → completed / failed / cancelled | Pinned to the workflow version it started on |
| Booking / service job | requested → triaged → quoted → approved → scheduled → en route → on site → completed → invoiced → closed; cancelled; reopened (warranty) | Arrival *window* vs confirmed *ETA* kept distinct |
| Payment | created → pending → paid / failed / expired → refunded (partial/full) / disputed | Only signed provider events and reconciliation move it |
| AI action | proposed → awaiting approval → approved → executed → confirmed / failed / compensated | Nothing is reported to a customer as done until "confirmed" |
| Promise (CF-EXT-018) | suggested → confirmed → due → kept / missed → recovered | AI can only reach "suggested" |

## AI design (Wave 2)

- **Provider-neutral gateway** with per-company budgets, rate limits, model/version tracking and fallbacks.
- **Retrieval per company**: chunks stored with `tenant_id` under RLS; retrieval runs in the company's context.
- **Tools, not free text, for facts and actions.** Prices, availability, orders, bookings and refunds come only from
  tool calls to systems of record; each tool has an allowlist, the caller's permissions, a confirmation gate for
  irreversible actions, and an audit record (CF-EXT-021).
- **Rehearsal mode** (CF-EXT-019) runs the same engine with every side-effecting adapter replaced by a recorder; the
  run is marked as a rehearsal in the database and cannot reach a live adapter.
- **Evaluation before change**: a fixed English/Arabic/Gulf-dialect test set (CF-EXT-010) runs before any model or
  prompt change is published.

## Integrations (Waves 2–3)

- One adapter per provider with its own verification: Salla signature header; Zid Basic Auth; Tap `hashstring`
  HMAC; HyperPay AES-GCM encrypted webhooks; Moyasar secret token (details in `external-dependencies-and-costs.md`).
- Credentials per company, encrypted, never returned by the API, rotated on schedule (Salla refresh tokens are
  single-use: refresh under a lock).
- A **system of record** stated per integration (for example: Salla/Zid own products, stock and orders; ConversaFlow
  owns conversations and consent).

## Regional hosting (Wave 3)

A Saudi-hosted option must cover the database, files, backups, logs, analytics, AI providers and support access
paths, not only the application servers. PDPL allows transfers under conditions, so localisation is a product option
and a sales requirement for some customers rather than a universal legal mandate (to be confirmed by qualified
counsel).
