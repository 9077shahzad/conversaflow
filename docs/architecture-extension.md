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

## Reliable sending (built in slice 2, `138869e`; retry rules and failure kinds in slice 3)

- One `send_jobs` row per outbound message (unique), leased through `dispatch_claim` (owned by NOLOGIN `cf_dispatch`,
  which sees scheduling columns only). Each job is processed as `cf_app` inside its company's context.
- **Before** the provider call, the message is marked `submitting` and committed.
- **Two outcomes are kept apart in the data, the code and the screen:**
  - `failed` is a **confirmed failure**: we know the customer did not receive the message. Every failed message carries
    `failure_kind`: `blocked` (our own checks stopped it before sending), `rejected` (the provider refused it),
    `exhausted` (the provider answered "not accepted" on every one of 5 attempts) or `provider_reported` (accepted,
    then reported as undelivered). A database constraint requires a kind on every failed message and none on any other.
  - `uncertain` means **we do not know**: the request may have reached the provider, but no answer came back. It is
    never resent automatically, and a person must confirm that the customer could receive it twice before retrying.
- **What prevents duplicate processing when the provider receives a request but its answer is late or never arrives:**
  1. The provider is called only after the message moved from `queued` to `submitting` under a row lock and that was
     committed. Any later attempt that finds `submitting` or `uncertain` does not call the provider; it marks the
     message `uncertain`.
  2. Only an explicit "not accepted" answer from the provider (such as a rate limit) puts a message back in the queue.
     A timeout, a reset connection, a server error or anything unrecognised is `uncertain`.
  3. The 30-second provider timeout only limits how long we wait. It does not stop the provider from completing a
     request it has already received, so a timeout always counts as `uncertain`, never as a failure. An answer that
     arrives after we stopped waiting is discarded.
  4. Every send carries our message id as Meta's `biz_opaque_callback_data`, which Meta echoes in status webhooks
     (Meta status webhook reference, read 20 Oct 2026, page undated). A later status settles an uncertain message
     (sent, delivered, read or failed) without resending it.
  5. The timeout is well below the 120-second lease, so normally no second worker can take the job while the first is
     still waiting. Duplicate prevention does not depend on this timing: a worker that stalls past its lease still
     cannot cause a second send (rule 1), and its late result is recorded on the same message.
  6. A request-level idempotency key for Meta's send endpoint was not verified in the sources checked (21 Oct 2026).
     Until one is confirmed in Meta's documentation, rules 1–4 are the protection. The remaining duplicate risk is a
     person retrying an uncertain message, which needs explicit confirmation.
- **Conditions are re-checked at the moment of sending:** the sender still has permission to reply and is still an
  active member, the conversation is not assigned to someone else, replies are not paused (except for the person who
  paused them), the customer has not opted out, the channel is on and the 24-hour window is open.
- **Manual retry (owner decisions 20 and 21 Oct 2026):** anyone who may reply to the conversation now may retry a
  failed message, including a colleague's. The retry is a new message linked to the original; the database records the
  original author and the person retrying, and derives the retry chain itself (`retry_root`, `retry_number`), so a
  retry copy cannot be retried again to get round the limit of one retry per original message.
- Inbound webhook processing stays in-request: it is idempotent and Meta retries on failure for up to 7 days.

## Templates, media, response targets and channel health (slice 3)

**Templates.** Templates belong to the WhatsApp Business Account (WABA), not to a number. Each company's accounts are
recorded in `provider_accounts` (one account can belong to only one company). Meta reports review decisions, quality
ratings and category changes by webhook with the WABA id as `entry.id` (Meta webhook references
`message_template_status_update`, `message_template_quality_update`, `template_category_update`, read 21 Oct 2026,
pages undated). They are routed by `account_route()`, owned by `cf_channel`, which can read only five columns of
active accounts — the same pattern as `channel_route()`, pinned by the CI guard. A template can be sent only while
approved; approval, account, opt-out and (for marketing) recorded marketing consent are checked again at send time. An
announced category change is shown but applied only when Meta reports it complete. Recovery: a sync re-reads status,
quality and category from the provider.

**Media.** An inbound media message is recorded at once with the provider's media id; a `media_jobs` row is leased by
the worker through `media_claim()` (owned by `cf_dispatch`, scheduling columns only, pinned by the guard). The worker
downloads the file, checks the delivered type and size against Meta's published limits (media page, read 21 Oct 2026,
page undated) and our own storage limit, scans it with ClamAV and stores it in the company's own folder. Nothing is
linked to the message until the scan says clean; no clear answer from the scanner means "try later", never "accept".
Media ids from webhooks expire after 7 days, so downloads run promptly with bounded retries, and a failed download can
be retried only within that time. Outbound media must be a stored, clean file of the same company, of a type and size
WhatsApp accepts; it is re-checked and read before anything is marked as submitting.

**Response targets (SLA timers).** A timer starts when a customer writes and nobody owes them an answer: "first reply"
if the conversation has never been answered, otherwise "next reply". The due time is counted in business hours in the
company's time zone, skipping holidays, or in calendar time if no hours are set. The timer stops only when a reply from
the team is accepted by the provider (a blocked or failed reply is not an answer; an uncertain one counts once the
provider confirms it). A met or missed target is recorded as a conversation event with how late it was; an open timer
past its due time shows as overdue.

**Channel health and recovery.** One company's view: connections and their last events, sending queue (waiting,
delayed, stuck, given up), delivery problems split into uncertain and the four kinds of confirmed failure, media
downloads, and template status. Recovery actions are restricted to ones that cannot message a customer twice:
re-applying delivery updates that arrived early, downloading a customer's file again, and re-reading template status.
Retrying a message happens only in its conversation, through the normal retry and its checks. Viewing needs
`channels.monitor`; recovery needs `channels.manage` (two-step sign-in), and every action is audited.

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
