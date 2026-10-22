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
  6. **Late answers (21 Oct 2026).** After the 30-second wait the request is kept open for up to 60 more seconds (still
     inside the lease) only to capture a late answer. If WhatsApp's message id then arrives, it is recorded on the same
     message (`send_attempts` outcome `late_accepted`): an uncertain message becomes sent; a delivered, read or failed
     message keeps its status; nothing is resent. The request is then cancelled.
  7. **Exact matching.** A status update is matched to a message by WhatsApp's message id, or, while we do not know that
     id, by our own message id echoed back as `biz_opaque_callback_data` — never by the customer's number or by time.
     A reference cannot attach a second provider id to a message that already has one, and one provider id can never
     belong to two messages (unique per company). Tested with several messages to the same customer whose answers were
     lost and whose updates arrive out of order.
  8. **Evidence.** Every attempt is recorded in `send_attempts`. "Not accepted after 5 attempts" (`exhausted`) is used
     only when all five attempts are recorded as definite refusals and no attempt of that message was ambiguous;
     otherwise the message stays uncertain.
  9. A request-level idempotency key for Meta's send endpoint was not verified in the sources checked (21 Oct 2026).
     Until one is confirmed in Meta's documentation, rules 1–8 are the protection. The remaining duplicate risk is a
     person retrying an uncertain message, which needs explicit confirmation.
- **Conditions are re-checked at the moment of sending:** the sender still has permission to reply and is still an
  active member, the conversation is not assigned to someone else, replies are not paused (except for the person who
  paused them), the customer has not opted out, the channel is on and the 24-hour window is open.
- **Retry eligibility by type:** an ordinary reply or media message can be retried only while the 24-hour window is
  open; an approved template can be retried outside it, but only while still approved (and, for marketing, with
  recorded consent). The server gives each failed message the reason it cannot be retried now, if any.
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

## Campaigns (slice 4)

- **Audience.** Contacts with a WhatsApp number and **recorded marketing consent**, not opted out, not on the
  suppression list, optionally only those who wrote within N days. Consent is required for every campaign, whatever the
  template's category. The preview shows the eligible count, every exclusion with its reason, personalised samples,
  how many days the number's daily limit will need, and a cost estimate.
- **Cost estimate.** Only verified Meta rates are used. Three distinct answers: an estimate from verified rates; "estimate
  unavailable" with the markets that lack a verified rate (today: Saudi Arabia and UAE marketing rates are drafts from a
  secondary source), which is explicitly not a cost of zero and shows no figure; and "no cost" when nobody would
  receive the campaign.
- **When recipients are chosen.** At the moment the campaign starts, not when it was scheduled. Each recipient is checked
  again when its message is queued (opt-out, consent, suppression, frequency limit, template still approved) and again
  by the sender just before it leaves (campaign still running, opt-out, consent, suppression, conversation not paused).
  An opt-out received after scheduling is therefore respected at every later step.
- **Frequency limits.** Per company: at most N campaign messages per contact in 7 days (default 2) and a minimum gap
  between campaign messages (default 24 hours). Per number: at most the company's daily limit of campaign messages in a
  rolling 24 hours (default 250, Meta's starting messaging limit; never above the number's tier).
- **What counts toward the limits** (migrations 0034–0036, `campaign-limits.ts`): campaign messages only, one count per
  hand-over to WhatsApp, timed from that hand-over. A hand-over keeps counting whatever happens next (in flight, sent,
  delivered, read, uncertain, interrupted, reported undelivered), except when it never reached anyone: that attempt
  was declined ("not accepted") or refused ("rejected"), or the message ended as "rejected", "exhausted" or
  "blocked". A retry is a new hand-over, checked in full at its own time. Ordinary
  replies and individually sent templates do not count. When queueing, messages already queued count too, as if sent
  now; at send time each message is counted when it goes.
- **Checked twice.** When queueing (planning: how many to queue, who to skip) and again immediately before sending. The
  send-time check takes a per-company lock, checks the contact's 7-day count and minimum gap and the number's 24-hour
  count, and records the message as counted in the same transaction that moves it to "submitting". Two senders or
  two campaigns therefore cannot both take the last place. A contact over its limits is not sent the message
  ("frequency_limit"); a number without room holds the message, with no attempt counted, until the oldest counted
  message turns 24 hours old. This covers messages delayed by a pause, a backlog or a lowered limit. Batches of one company run one at a time (a lock per company), so
  two workers on different campaigns cannot both use the same room. A batch that changes nothing (no room yet, or
  waiting for its queued messages to leave) keeps its lease for 30 seconds, so the worker does not pick it up again at
  once. The daily count covers campaign messages only, per
  number; Meta's own limit counts unique customers per business portfolio, which the live adapter must respect.
- **Pause, resume, cancel.** Pausing stops queueing; messages already queued are held by the sender (no attempt is
  counted) until resumed. A campaign paused before it started resumes as scheduled, so its recipients are still chosen
  when it starts. Cancelling is final: waiting recipients are skipped and queued messages not yet sent are stopped. A
  campaign is marked completed only when nobody is left to queue and none of its messages is still waiting, so it can
  be paused or cancelled for as long as anything can be stopped. The sender reads the campaign under a share lock, so a
  cancel either lands before a message moves to "submitting" (and stops it) or after (when it is already with
  WhatsApp). Every change is audited.
- **No individual retries.** A failed or uncertain campaign message cannot be retried from the inbox: a retry would be
  an ordinary message and would skip the campaign's checks.
- **No duplicate sending.** One recipient per contact per campaign (unique); one message per recipient (unique); the
  message's idempotency key is the recipient id; recipient and message are written in one transaction; the worker
  leases each campaign through `campaign_claim()` (owned by `cf_dispatch`, scheduling columns only, pinned by the
  guard). A crash in the middle of a batch queues nothing; the next run queues everyone exactly once. Individual send
  failures are recorded per message and do not stop the others; nothing is resent on later runs.

## Contacts, tags, saved replies and automatic assignment (slice 5)

- **Contact import (migration 0038).** Two steps. The preview reads the CSV (quoted fields, Windows line endings,
  byte-order mark; English or Arabic column names) and classifies every row: new, already a contact, repeated in the
  file, or not usable with the reason (no number, a local number without its country code, an invalid number, a bad
  language or consent value). Numbers are cleaned to international digits; a local number is refused rather than
  guessed, because a wrong guess would message a stranger. The import applies the stored preview within 24 hours and
  checks every row again at that moment, under the same per-number lock as an incoming message, so an import and a
  first message cannot create two contacts. Existing contacts keep their name and language; only missing values are
  filled. At most 5,000 rows and 2 MB per file. Nothing is ever sent.
- **Marketing consent on import.** Recorded only together with the company's statement of how the customers agreed,
  which is required for the whole file when any row says yes, and stored in each consent event. Never recorded for a
  customer who has opted out of all messages. A "no" in a file never removes consent a customer gave.
- **Undo.** Removes contacts the import created that have no conversation, keeps those who have written in, and
  withdraws consent the import recorded if that is still the latest decision for the contact (with a consent event
  saying so). The database itself refuses to delete any other contact (a trigger), so the application's new delete
  right is limited to this case.
- **Tags and saved replies (migration 0037).** Company-wide lists. Supervisors and above manage them; anyone who can
  reply in a conversation puts tags on it (recorded in the conversation history) and can filter the inbox by tag.
  Saved replies are inserted into the reply box with `{name}` filled in, and sent only when the agent presses Send,
  with every usual check.
- **Automatic assignment (migration 0039).** Off by default. When on, a customer's first message in a conversation
  nobody has (a new one, or one a campaign started) gives it to the next member on the company's assignment list who
  is active and allowed to reply: in turn (round robin) or to whoever has the fewest open conversations, ties in turn.
  Optionally only during business hours. A conversation someone already has is never moved. One company's
  assignments are made one at a time under a lock, taken at the start of the webhook transaction (before any customer
  lock) so two deliveries cannot deadlock; at pilot scale this serialises a company's incoming messages only while
  assignment is on. Rule changes are audited.

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
