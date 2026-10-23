# Conversa Operator addendum v1.0: gap matrix grounded in the repository

Source: `docs/operator/operator-addendum-v1.0-source.txt` (552 lines, read in full). Repository: `/home/claude/conversaflow`,
branch `feature/brd-v1.2-wave1`, migrations 0001–0058. Prepared 23 Oct 2026 by reading code, migrations, tests and docs
only. Nothing was built, run or tested for this matrix.

**Status codes.** **Exists**: built and covered by local tests for today's scope. **Partial**: some of it is reusable or built,
and the rest is listed. **Missing**: not in the repository. **External**: needs a provider, credential, hosting or owner
decision (it can appear together with Missing). "Local" always means the simulated WhatsApp sandbox, the simulated AI and the
ClamAV test signature (`docs/reports/wave2-report.md`). Nothing has been verified in CI, in hosting or live.

**Facts that apply to every row**
- The application has no quote, booking, capacity, job, dispatch, invoice, payment or transcription code, tables or tests. A
  search for `quote|booking|payment|invoice|capacity|transcri` in `apps/` and `packages/` only finds pack/tag text
  (`setup.ts` "Quote sent", "Visit booked"), AI-checker word lists (`ai-check.ts`) and the outcome report's "not measured" note.
- **DOP / Field Force:** nothing in the repository mentions either one (searched `\bDOP\b` and `field.?force` across all .ts,
  .tsx, .sql, .md and .json files). There is no API contract, client, stub or documentation for them. Payment providers
  (Moyasar, Tap, HyperPay) exist only as research notes in `docs/external-dependencies-and-costs.md` §payments.
- Name clash: `workflows`, `workflow_versions`, `workflow_runs` and `workflow_run_steps` (migration 0045) already mean
  *messaging automations*. Operator's "workflow definition/run" needs different names, such as `service_cases`/`case_runs`.
- `outbox_events` appears in the design doc (`docs/architecture-extension.md` §Reliable processing) but **no migration
  creates it**.

## 1. Requirement matrix

### Customer experience (UX)

| ID | Short name | What exists (verified) | Status | What R1 still needs |
|---|---|---|---|---|
| UX-01 | Brand and familiar labels | Product UI is "ConversaFlow" (`apps/web/lib/i18n.ts`). Pages: inbox, contacts, campaigns, automations, ai, promises, reports, setup, templates, channel-health, developers, settings, plus the customer page `c/` | Partial | Operator pages for Jobs, Quotes, Approvals and Exceptions, with EN/AR copy in `i18n.ts` |
| UX-02 | Full EN/AR, RTL, locale formats, PDF | `i18n.ts` holds both languages. `formatDate`/`formatNumber` (`i18n.ts:1144-1145`) use Latin digits with a Gregorian calendar. `ui.spec.ts` asserts `dir=rtl` and covers mixed-direction truncation (l.62) | Partial | A currency formatter that knows minor units per currency (none exists; campaign cost is just `{total} {currency}`). Quote/invoice PDF output (none exists). Arabic PDF tests |
| UX-03 | Journey over WhatsApp and secure links | Customer page with expiring, revocable links (W2.4, `customer-links.ts`, 0051, `customer-links.test.ts`). It offers status, language, consent, "talk to a person" and complaints | Partial | Quote review, booking confirm/change and job status pages. Interactive WhatsApp buttons: `parseWebhook` in `channels.ts` handles only text/media messages, statuses and template events, so button/list replies and location messages are not parsed |
| UX-04 | No repeat questions; confirm ambiguity; relative dates in tz | Company time zone and hours (`sla.ts` `companyHours`). `promise-detect.ts` turns "tomorrow"/"بكرة" into dates in the company tz for promises only. Original text is kept for translations (`message_translations`) | Missing | A structured-facts store with provenance and confirmation states, a clarification policy, and service-location tz resolution |
| UX-05 | Honest separated statuses | Pattern exists for messages: `sent` vs `uncertain` vs `failed` (`sender.ts` header). Promise statuses (0053) | Missing | Separate quote, hold, booking, job, completion, acceptance, invoice and payment states with customer-facing copy |
| UX-06 | Costs clear before acceptance | Nothing | Missing | Quote presentation covering scope, exclusions, tax, call-out, deposit, window, expiry and terms, plus renewed acceptance on change |
| UX-07 | Identify automation; no impersonation | AI answers get "(Automated reply)"/"(رد آلي)" (`automations.ts:621-624`) **but the tenant can turn it off** (`ai.ts` `disclose`; owner-actions item 11 still open) | Partial | Disclosure must not be switchable for Operator replies (see Risks). Automation messages (`send_reply`) carry no disclosure |
| UX-08 | WCAG 2.2 AA with manual checks | `ui.spec.ts` (11 tests) runs axe with tags `wcag2a, wcag2aa, wcag21aa` and fails only on serious/critical | Partial | Add the `wcag22aa` tag, record manual checks (none recorded that I could find; unverified), and cover the new screens |
| UX-09 | Loading/empty/error/denied states | The wave reports say existing screens have them. I did not check them screen by screen (unverified) | Partial | The same states on every Operator screen and customer view |
| UX-10 | Guided setup to enable module | `setup.ts` (W2.7): a derived checklist and a `home_services` pack (tags, saved replies, draft articles, draft automation). `setup.test.ts` | Partial | Steps to set up services/prices, areas/hours, ops and payment connections, approvals, a test journey and enablement. Saved progress and dependency status |

### Functional (FR)

| ID | Short name | What exists (verified) | Status | What R1 still needs |
|---|---|---|---|---|
| FR-01 | Intake and identity | Text and media inbound (`inbound.ts`, `channels.ts`). Tenant-scoped `contacts`/`contact_identifiers` (0022). Webhooks are routed by `channel_route` (no cross-tenant merge, enforced by RLS) | Partial | Service locations, linking enquiries to them, and verification for sensitive changes. Contact merges are not auto-merged today; the merge UI is unverified |
| FR-02 | Structured service request | Nothing | Missing | `service_requests` entity with tri-state fields (unknown / not-applicable / confirmed) |
| FR-03 | Voice, photo, limits, scan, quarantine | `MediaFetcher` (`media.ts`) downloads, scans and stores media. A file is stored only when clean, and "no clear answer" from the scanner means retry (`media.test.ts` l.167). `WHATSAPP_MEDIA` sets size limits and `MAX_UPLOAD_BYTES`=16MB. Type checks use only the declared MIME allowlist (`acceptsInbound`, `files.service.ts` `ALLOWED_TYPES`). I found no magic-byte check | Partial + External | Transcription provider and adapter, transcript view, audio duration limits, real file-type validation, and an image-interpretation interface (optional). Unscanned files must never reach a model; no model path exists yet |
| FR-04 | Versioned business knowledge | `knowledge_articles` (0047) with `published` and `language`. AI must cite them, and numbers must appear in a cited source (`ai-check.ts`) | Partial | Versions, effective dates, source references, review owner and conflict/outdated flags. Prices must come from rates, never articles |
| FR-05 | Catalogue and eligibility | Business hours and holidays (`sla.ts`), `branches` (0008, timezone and address) | Missing | Catalogue, tasks, exclusions, coverage areas, skills, durations, inspection rules and an unsupported-request queue |
| FR-06 | Deterministic pricing and margin | Integer cents exist only for plans (`price_monthly_cents`, 0004) | Missing | Rate versions, tax, minimums, travel, discounts, deposits and validity per jurisdiction, all in integer minor units, plus estimated vs actual margin |
| FR-07 | Immutable quote versions | Immutability pattern exists in `workflow_versions` (0045) and frozen plan versions (`plan_version_frozen()` trigger) | Missing | `quotes`/`quote_versions` storing what was sent and what was accepted |
| FR-08 | Secure acceptance, no replay | Customer link token is 256-bit, hashed, re-checked on every request, rate-limited and CSRF-guarded (`customer-links.ts`, `guard.ts:70-72`). It is a **multi-use, contact-scoped bearer link that lives up to 30 days** | Partial | Single-use acceptance nonce bound to tenant, contact, quote version and terms version. Chat-acceptance clarification. Authorization levels for refunds and discounts |
| FR-09 | Capacity and holds | Nothing | Missing + External | Capacity source (ops backend or native resources), expiring holds, atomic commit and a concurrency test |
| FR-10 | Booking | Nothing | Missing | Bookings with history, plus reschedule/cancel rechecks |
| FR-11 | Dispatch via connector | Nothing. No DOP/Field Force contract in the repository | Missing + External | Connector contract, adapter, "last update" freshness and dispatch exceptions |
| FR-12 | Completion evidence | Files and scanning are reusable (`files`, 0005) | Missing | Checklists, evidence rules, sign-off and separate completion/acceptance/settlement statuses |
| FR-13 | Payments via provider | Research notes only (`docs/external-dependencies-and-costs.md` l.53-55) | Missing + External | Merchant account, hosted payment page adapter, signed event verification and reconciliation. Must stay separate from subscription billing (which is also not built) |
| FR-14 | Payment exceptions | Nothing. The `uncertain` → lookup-before-retry pattern in `sender.ts` is the model to copy | Missing + External | Pending, failed, partial, overpaid, refunded, disputed and reconcile-required states, plus late payment after hold expiry |
| FR-15 | Persistent recovery and exception queue | Leased jobs with back-off: `send_jobs` (0024), `webhook_events` retries and failures (`inbound.ts` `INBOUND_LIMITS`), `workflow_runs` `failedAttempt`. Channel-health page with safe re-apply (`health.service.ts`, `health.test.ts`) | Partial | Business-case tracking to a terminal outcome. Error taxonomy (retryable / business / unknown / owner-action). Staff exception queue |
| FR-16 | Human takeover and handback | `stopAutomationRuns` runs on reply, assign, pause, resolve and person_requested. Sender re-checks `person_since`/`assigned_since`/paused (`sender.ts:151-209`). The AI step re-checks the settings version and the last inbound before posting (`automations.ts:613-620`). Tests in `automations.test.ts` l.163, l.181, l.304, l.342, l.435 | Partial | Hand-over packet (facts, quote/job refs, pending actions, reason). **Explicit authorized handback**: today automations restart on their own 24h after the last human reply (`AUTOMATION_LIMITS.humanQuietHours`, `automations.ts:356-360`). Stopping in-flight connector writes |
| FR-17 | Linked operational record | `conversation_events`, hash-chained `audit_events` (0005, `audit.test.ts`), `ai_interactions` (0047) | Partial | Entities from enquiry to payment, with actor, source, external ref and rule version |
| FR-18 | Follow-ups, quiet hours, consent split | Templates, 24h window, opt-out and marketing consent are re-checked at send time (`sender.ts:185-222`). Service consent (`opted_out_at`) is separate from marketing consent (`marketing_consent_at`). Campaign skip reasons are shown (W1.14) | Partial | Customer reminders, surveys, renewals and open-quote follow-up. **Customer quiet hours** (none exist: `humanQuietHours` is about staff activity). Skip-reason reporting for Operator sends |
| FR-19 | Funnel reporting | `outcomes.ts` (W2.9) says it does **not** measure bookings, payments or refunds. Unknown costs stay unknown. `outcomes.test.ts` | Partial | Enquiry-to-paid funnel, coordination time and reconciliation gaps, with metric definitions |
| FR-20 | Campaign/ad continuity | `conversation_attributions` (0043), `reports.ts` ad report labelled as association only, `ads-report.test.ts` | Partial | Link attribution to quotes, bookings and paid jobs |
| FR-21 | Tenant administration | Versioned AI settings with audit (`ai.ts` `saveSettings`). Automations draft/publish/rollback. Feature flags (0008, `platform_set_feature_flag` with platform-owner token) | Partial | Settings for services, thresholds, integrations, spend, evidence and workflow versions, with preview and change history |
| FR-22 | Procedure authoring | Automations: validation (cycles, unreachable steps), draft/publish/rollback, versions kept for in-flight runs (`automations.ts:82-117`). Setup's "describe it in your own words" handles a fixed set of phrasings and only creates drafts (`setup.ts`) | Partial | Operator templates, a guided editor and conflict checks for service procedures |
| FR-23 | Off / Assist / Approval / Limited modes; emergency pause | `ai_settings.enabled` **defaults false** (0047 l.9), modes `suggest`/`answer`. Pause exists per conversation (0024), per automation (`setStatus`), per campaign, per channel (`channel_status`) | Partial | Approval-required and limited-autonomous modes per workflow. **No tenant or platform emergency pause exists.** The sender does not check `tenants.status` (`dispatch_claim` in 0024 has no tenant filter; only customer-links and API keys refuse suspended tenants) |
| FR-24 | Metering and cost ceilings | AI budget reserved before each call (`ai.ts` `budgetedCall`, `ai.test.ts` l.153). `usage_events`/`provider_rates` (0007). Automation allowance (`entitlements.service.ts`). Plan limits (`limits.test.ts`, `commercial.test.ts`) | Partial | Messaging cost tied to sends (W1.11 partial), processing/transcription metering, per-workflow ceilings, alerts and loop caps for connector retries |

### Architecture (AR)

| ID | Short name | What exists (verified) | Status | What R1 still needs |
|---|---|---|---|---|
| AR-01 | Extend actual stack, modular monolith | NestJS API and one worker process (`worker.ts`), PostgreSQL 16, Redis rate limiter. No microservices | Exists | Keep it: Operator becomes modules plus worker loops |
| AR-02 | Logical components | Channel adapters and ingress, identity/RBAC, conversations, media, knowledge, AI gateway, durable jobs, audit, customer links, staff UI | Partial | Planner, policy layer, typed action registry, connectors, quote/booking/outcome records, exception management |
| AR-03 | Planner separated from execution | The AI never acts: it can only answer, suggest or ask for a human (`ai.ts` header). Answers are post-checked (`ai-check.ts`). The provider gets no tools | Partial | Typed action registry with server-side validation of tenant, actor, permission, state, approval and idempotency for every write |
| AR-04 | Durable workflow state | Database-leased loops: `dispatch_claim`, `inbound_claim`, `automation_claim`, `webhook_claim`, `media_claim`, push/promise watchers (`worker.ts`). Runs store `next_at` for timers | Partial | Durable case state and timers for holds, expiries and reconciliation. ADR comparing this to Temporal (none exists; "temporal" is not mentioned in the repository) |
| AR-05 | Outbox and inbox | Inbox: `webhook_events` unique `(tenant, connection, event_key)` recorded before acknowledgement and applied by the worker (0022/0042, `inbound-worker.test.ts`). Outbox for outgoing webhooks only: `emitEvent` inserts `webhook_deliveries` in the caller's transaction (`public-api.ts:447`) | Partial | General `outbox_events` for connector commands, inbound ledgers for connector and payment webhooks, and the full event envelope from addendum §8 |
| AR-06 | Bounded parallel reads | Nothing | Missing | Parallel catalogue/territory/capacity reads, re-validated at commit |
| AR-07 | Schemas, timeouts, retries, DLQ, replay | zod everywhere. Versioned `/v1` public API. Timeouts in sender (30s), AI (20s) and webhooks (10s). Exponential back-off **without jitter** (`sender.ts:328`). `dead`/`failed` states. Replay limited to channel-health re-apply and webhook resend | Partial | Jitter, circuit breakers (designed, not built), connector DLQ, controlled replay and lookup-before-retry for connectors |
| AR-08 | Explicit state machines | Built: message status (forward-only), conversation, assignment, workflow run, promise. Booking/payment/AI-action machines exist **as design only** (`architecture-extension.md` §State machines) | Partial | Implemented quote, hold, booking, job, payment and case machines with transition guards in the database |
| AR-09 | Versioned definitions for in-flight runs | Runs stay pinned to their `workflow_versions` row (test "a run follows the version it started on", `automations.test.ts` l.141) | Partial | The same pinning for Operator procedures, rate versions and terms versions, plus a worker compatibility check |

### Security (SEC)

| ID | Short name | What exists (verified) | Status | What R1 still needs |
|---|---|---|---|---|
| SEC-01 | Tenant from trusted mapping | Membership actor (`rbac.ts`, `http/guard.ts`). `channel_route`/`account_route`/`customer_link_route` definer lookups. `ApiAuth`. Test: tenant id smuggled in body/query is ignored (`isolation.api.test.ts` l.68) | Exists | Same mapping for connector and payment webhooks (merchant/account → tenant) |
| SEC-02 | Scope everywhere | Forced RLS on every tenant table, enforced by `packages/database/src/check-rls.ts`. Storage keys `tenants/<id>/` re-checked (`sender.ts:230`, `files.service.ts:121`) | Exists (for current tables) | Every Operator table, queue and claim function under the guard. Tenant-scoped cache keys for any new Redis use |
| SEC-03 | Isolation with real roles; definers reviewed | `isolation.db.test.ts` connects as the app role and reads the table list from the catalogue. `check-rls.ts` pins every SECURITY DEFINER by md5 (81 definer occurrences in migrations) | Exists (local; CI pending) | New claim and routing definers must be added to `REVIEWED_DEFINERS` / `COMPANY_TABLE_READERS` |
| SEC-04 | Least-privilege roles | Five system roles: owner, admin, supervisor, agent, analyst (`rbac.ts`, 0031). Time-limited support access (`support_access_grants`, 0008, `platform.test.ts`) | Partial | Dispatcher, field worker, finance reviewer and auditor roles, plus Operator permissions with an upgrade migration like 0031 |
| SEC-05 | Secrets, links, audit | `WEBHOOK_SECRETS_KEY` sealing outside the database. Secrets come from environment variables (no secret manager, no hosting). Customer links are hashed, expiring and revocable, and masked in AI/inbox output (`maskLinks`) | Partial + External | A secret manager once hosting exists. Connector credentials per tenant, sealed. Action-scoped single-use links (see FR-08) |
| SEC-06 | Untrusted content and injection | Customer text passed as data. `looksLikeInjection` (EN/AR). Answers withheld unless the checks pass (`ai.test.ts` l.115, l.125) | Partial | Same handling for transcripts, image descriptions and connector outputs. Adversarial test set |
| SEC-07 | Outbound restrictions, SSRF | `checkEndpointUrl`/`isPrivateAddress` for webhooks (port 443/8443, re-checked when connecting). Push endpoint allowlist (`push.ts` `isPushServiceUrl`) | Partial | Connector destination allowlist, redirect and size limits, and validation of tool output |
| SEC-08 | Auth, MFA, webhook authenticity | MFA for privileged roles (ADR-027/032/033). CSRF header plus origin check (`guard.ts`). HMAC check on the sandbox webhook. Per-IP/link rate limits (`core/rate-limit.ts`) | Partial | Signature and replay checks for payment and connector webhooks. Step-up for financial approvals |
| SEC-09 | OWASP ASVS 5.0 L2 baseline | CSP with nonce (ADR-028, `apps/web/middleware.ts`, `app.ts:134`). XSS-safe rendering is unverified. No ASVS mapping in `docs/security/` | Partial | ASVS 5.0 L2 checklist with evidence. Test that opening a link never authorizes an action |
| SEC-10 | Retention, deletion, export, region | `retention_policies` table (0007) with no purge job (wave2-report residuals). Import previews cleared after 1 day. No export/delete flows. Region pinning for AI not built | Partial + External | Purge, export and delete jobs. Separate financial record retention. AI region config (owner/legal decision, owner-actions item 8) |

### Platform and regional (PL)

| ID | Short name | What exists (verified) | Status | What R1 still needs |
|---|---|---|---|---|
| PL-01 | Official WhatsApp APIs only | Sandbox adapter only, refused in production (`worker.ts:79-81`). W1.10 blocked on Meta (implementation-backlog) | External | Meta business verification, Tech Provider status and the Cloud API adapter |
| PL-02 | Opt-in/out, templates, window, re-check at send | Opt-out keywords (EN/AR). Template approval/account/category and the 24h window are re-checked at send (`sender.ts:185-222`; `sending.test.ts` l.247; `templates.test.ts`). Simulated only | Exists (local, simulated) | Utility-template paths for Operator notifications. Live template review (External) |
| PL-03 | AI terms per jurisdiction | Not verifiable in the repository | External | Owner/legal check of the WhatsApp Business Solution terms (the addendum notes the page was not retrievable) |
| PL-04 | Jurisdictional tax/invoice/privacy config | ZATCA/PDPL notes only in `docs/external-dependencies-and-costs.md`, `brd-v1.2-addendum.md` CF-EXT-027 | Missing + External | Per-jurisdiction tax and invoice configuration. Legal review before any compliance claim |
| PL-05 | Consent types distinct; no card data in chat | Service vs marketing consent are separate columns with `consent_events` evidence | Partial | Location permission, minimal data collection, and a guard plus copy against card details in chat |

### AI quality (AI)

| ID | Short name | What exists (verified) | Status | What R1 still needs |
|---|---|---|---|---|
| AI-01 | Provider-independent interfaces | `AiProvider` interface with simulated and Anthropic providers (`ai-provider.ts`; Anthropic **never run live**) | Partial + External | Transcription and image interfaces, model selection by measured results, live provider account (owner-actions item 5) |
| AI-02 | Schema-validated output, allowlisted tools | The Anthropic adapter parses JSON loosely by slicing out `{…}` (no zod schema). No tools beyond read-only "business hours" facts (`toolFacts`) | Partial | zod-validated structured extraction, a tool allowlist, and permission/state re-checks before each action |
| AI-03 | Tenant memory with provenance | Nothing beyond recent messages (`recentMessages`, 12) | Missing | A facts store that separates customer statements from confirmed system facts |
| AI-04 | Bounded context and spend per workflow | `AI_LIMITS` (4 articles, 600 output tokens, 20s). Monthly budget per tenant | Partial | Per-workflow limits on tool calls, retries, time and spend. Deterministic pricing path |
| AI-05 | Calibrated extraction, escalate uncertainty | Provider `confidence: 'low'` is used only as an extra withhold reason | Missing | Labelled calibration set and escalation rules for addresses, quantities, dates and authority |
| AI-06 | Version prompts/config; record decisions | `ai_interactions` records `settings_version`, `checker_version` (`checks-4`), model, citations, reasons and cost. The system prompt is hard-coded (`systemPrompt`) and not versioned | Partial | Prompt/model config versions, and records of tool inputs/outputs with redaction |
| AI-07 | Regression eval set (≥200 cases, voice) | `docs/readiness/pilot-synthetic-examples.md`. W3.4 Gulf-dialect set planned, not built | Missing + External | Frozen 200+ case set (80 AR / 80 EN). Recordings from consenting voice testers |
| AI-08 | Simulation without side effects | Automation rehearsal (CF-EXT-019). The database refuses messages linked to rehearsal runs (`automations.test.ts` l.232, l.331) | Partial | Rehearsal that covers connectors, payments and holds with recorder adapters, and keeps results apart |
| AI-09 | Shadow eval, gradual enablement, fallback | Provider failure → `human_needed` (`budgetedCall`). Answer mode is refused with the simulator in production | Partial | Shadow mode, per-tenant gradual enablement, and a regression gate before a model swap |
| AI-10 | Autonomy bounded by action permissions | Answer mode withholds action words and success claims (`ai-check.ts` `ACTION_WORDS`, `claimsSuccess`; `ai.test.ts` l.74) | Partial | Per-action permissions in the action registry, separate from FAQ answering |

### Acceptance scenarios (AC)

| ID | Short name | What exists (verified) | Status | What R1 still needs |
|---|---|---|---|---|
| AC-01 | Arabic voice note → structured request | Nothing (no transcription) | Missing + External | Transcription, extraction and one-time clarification |
| AC-02 | EN and mixed-language same workflow | Arabic keyword normalisation (`automations.ts` `tokens`/`base`) | Missing | The workflow itself |
| AC-03 | Noisy/contradictory → clarify or escalate | Nothing | Missing | Uncertainty policy and tests |
| AC-04 | Quote matches pricing fixtures | Nothing | Missing | Pricing engine and fixtures |
| AC-05 | Unknown fault → inspection | Nothing | Missing | Inspection rule in the catalogue |
| AC-06 | Expired/changed quote acceptance | Nothing | Missing | Quote versions, expiry and renewal |
| AC-07 | Last slot race | Concurrency patterns exist (assignment try-lock, `FOR UPDATE SKIP LOCKED` claims) | Missing | Capacity commit and race test |
| AC-08 | Duplicate/out-of-order inbound | Messages and statuses: `messaging.test.ts` (duplicates, reordering), `inbound-worker.test.ts`. Duplicate send jobs impossible (`sending.test.ts` l.131) | Partial | The same guarantees for quotes, jobs and financial events |
| AC-09 | Lost payment response → reconcile | Nothing to reuse except the sender's uncertain-state model | Missing + External | Provider lookup and reconciliation |
| AC-10 | Late payment after hold expiry | Nothing | Missing + External | Payment and hold reconciliation |
| AC-11 | Bad payment events rejected | Nothing | Missing + External | Signature, amount, currency, merchant and tenant checks |
| AC-12 | Crash after external job create | Pattern: `crashAfterSubmit` → `uncertain` (`sending.test.ts` l.113) | Missing | Connector idempotency key plus lookup on recovery |
| AC-13 | Takeover beats in-flight AI and queued write | Tests in `automations.test.ts` (l.163, l.181, l.304, l.435) and the AI re-check (`automations.ts:617`) | Partial | Same for connector writes and Operator actions |
| AC-14 | Worker unavailable → dispatch exception | Nothing | Missing + External | Dispatch exceptions and reschedule approval |
| AC-15 | Missing evidence blocks closure | Nothing | Missing | Evidence rules |
| AC-16 | Acceptance and payment independent of completion | Nothing | Missing | Separate state machines |
| AC-17 | Malicious photo instructions | Text injection only (`ai.test.ts` l.115). No path from image to model exists | Missing | Image/OCR path treated as data, plus tests |
| AC-18 | Forged IDs, cross-tenant access | `isolation.api.test.ts`, `isolation.db.test.ts` (messages, files, members, reports) | Partial | Extend to jobs, quotes, search and financial tables (they get covered automatically once they have `tenant_id`, per the test header) |
| AC-19 | Expired link, revoked user, field worker | Expired/revoked links (`customer-links.test.ts` l.133, l.150). Revoked member re-check (`files.service.ts:106`) | Partial | Field-worker role and action-scoped links |
| AC-20 | Tenant emergency pause stops queued work | Only conversation, automation, campaign and channel pauses | Missing | Tenant and platform pause checked in every claim/send/action path |
| AC-21 | Queued message eligibility change | `sending.test.ts` l.247. `template_required` outside 24h. Template status re-check | Exists (simulated) | Re-run for Operator notifications |
| AC-22 | Disconnected connector → truthful status + task | Channel health (`health.service.ts`) for WhatsApp only | Partial | Connector health and human tasks |
| AC-23 | Workflow deploy vs in-flight work | Version pinning test (`automations.test.ts` l.141) | Partial | Rate/terms pinning. No replay of charges |
| AC-24 | Restore without repeating side effects | No hosting, no backups (`infrastructure/README.md`: "no resources exist") | External | Hosting, backups, restore drill, hold-for-reconciliation flag |
| AC-25 | EN/AR mobile, RTL, keyboard, screen reader | `ui.spec.ts` (axe, RTL, 3 sizes) on existing staff screens and the customer page | Partial | New customer views, plus WCAG 2.2 and manual checks |
| AC-26 | Consent withdrawal, deletion/retention | STOP and customer page opt-out (`customer-links.test.ts` l.197) | Partial | Deletion/retention across DB, media, search and procedures |
| AC-27 | Caps, loops, tenant rate limits, alerts | AI budget, automation allowance, campaign frequency/daily limits, automation loop/step limits, API rate limits | Partial | Cost alerts, per-tenant fairness (claims are global FIFO, e.g. `dispatch_claim` orders by `next_attempt_at` only), connector loop caps |
| AC-28 | Original behaviour regression | 624/624 API and 16/16 browser locally at `8f96eff` (wave2-report) | Exists (local) | Re-run on every Operator slice. CI is still pending |

## 2. Reusable building blocks (and how Operator should use them)

| Block | Where | Reuse in Operator |
|---|---|---|
| Reliable sender | `modules/sender.ts`, `send_jobs` (0024), `send_attempts`, retry lineage (0025) | Send **every** customer message (quote links, confirmations, reminders) as an ordinary `messages` row with a job. Never send directly. Extend the send-time `refusal` chain with an Operator check (case paused / tenant paused / message superseded). Its `queued → submitting → sent / uncertain` design is the template for connector and payment commands |
| Inbound ledger and worker apply | `modules/inbound.ts`, `webhook_events` (0042/0044), `inbound_claim` | Hook Operator intake where `applyInboundMessage` runs (in the same transaction as `startAutomationRuns`). Copy the record-then-apply ledger for connector and payment webhooks (new tables, same pattern) |
| Automations engine | `modules/automations.ts`, 0045/0048/0050 | Reuse: version pinning, draft/publish/rollback, validation, rehearsal, takeover stop rules, plan reservation. Either add Operator step kinds (e.g. `start_case`, `handoff`) or keep Operator procedures as a separate engine that reuses `validateDefinition`-style checks. Do not overload `workflow_runs` with case state |
| AI service | `modules/ai.ts`, `ai-provider.ts`, `ai-check.ts`, 0047/0049 | `budgetedCall` (reserve → call outside the transaction → settle) for extraction and transcription costs. `ai_interactions` for explanations. `looksLikeInjection`, `normText` (Arabic/Indic digit normalisation) for parsing numbers. Add new tasks (`extract_request`) with zod output schemas |
| Customer links (W2.4) | `modules/customer-links.ts`, 0051, `customer_link_route` | Reuse token hashing, fragment transport, route lookup, rate rules and `live()` re-check. Add **action grants** (single-use, quote-version-bound) on top. The link alone must never authorize |
| Promises (W2.6) | `modules/promises.ts`, `PromiseWatcher`, 0053/0055 | Use for staff-side commitments (call back, send quote by X). The watcher's warn-then-miss pattern fits hold expiry and quote expiry timers |
| Push (W2.5) | `modules/push.ts`, `queueConversationNotice` | Alert staff on exceptions, approvals and late jobs (new notice kinds) |
| Public API and webhooks (W2.8) | `modules/public-api.ts`, 0056/0057 | `emitEvent` (in-transaction) and `WebhookWorker` (leased, signed, secret rotation, SSRF checks) for `quote.*`, `booking.*`, `job.*` events and the generic "existing external job system" connector. Add scopes for jobs/quotes |
| Outcome and ad reports | `modules/outcomes.ts`, `reports.ts` | Extend with funnel stages, keeping the "unknown stays unknown" rule and company-tz day boundaries |
| Media scanning | `modules/media.ts`, `core/storage.ts` (`ClamdScanner`, `scanWithBasis`) | Completion photos and customer photos go through the same scan-before-available path. Transcription must read only `files.status='available'` |
| Audit | `audit.service.ts`, `audit_events` hash chain (0005) | `AuditService.record(tx, …)` in the same transaction as every Operator state change |
| RLS guard | `packages/database/src/check-rls.ts`, `isolation.db.test.ts` | New tables with `tenant_id` + FORCE RLS. New claim definers pinned. Isolation test picks them up |
| Rate limiter | `core/rate-limit.ts` (`RATE_RULES`) | Acceptance and payment endpoints, per-tenant connector call budgets |
| Channel health and recovery | `health.service.ts` | Model for connector health and the "re-apply safely" actions |
| Feature flags | `feature_flags`/`tenant_feature_flags` (0008) | `operator` flag per tenant (platform-owner token required). Not a substitute for an emergency pause |
| Business hours / tz | `sla.ts` `companyHours`, `isWithinBusinessHours`, `branches.timezone` | Slot generation and relative-date resolution |
| Setup | `setup.ts` packs, checklist | Add an `ac_maintenance` pack and Operator checklist steps |
| Emergency pause | **None exists** | Must be built (see §3) |

## 3. Existing state machines and tables Operator must not duplicate

- **Messages**: `messages.status` queued → submitting → sent → delivered → read, plus failed (with `failure_kind`) and uncertain (0022–0025). Every Operator notification is a message.
- **Conversations**: open/pending/resolved, one open per contact and channel; assignment, takeover and pause on `conversations` (0024). Operator cases link to a conversation and do not copy its ownership. Takeover is `conversation_events` kind `takeover`/`assigned`.
- **Contacts and consent**: `contacts`, `contact_identifiers`, `consent_events`, `opted_out_at`, `marketing_consent_at`, `suppressions` (0033). No separate Operator consent table; add a service-location table that references contacts.
- **Automation workflows**: `workflows`, `workflow_versions`, `workflow_runs`, `workflow_run_steps` (0045). These names are taken.
- **AI**: `ai_settings` (enabled/mode/version), `ai_usage` (reservations), `ai_interactions` (explanations), `knowledge_articles`.
- **Usage and plans**: `usage_events`, `usage_counters`, `provider_rates`, `plan_entitlements`. Extend these for Operator metering rather than adding a parallel ledger.
- **Files**: `files` with scan status and basis (0005, 0032). `media_jobs`.
- **Promises**: `promises` (suggested → confirmed → kept/missed/recovered).
- **Customer links/requests**: `customer_links`, `customer_requests` (talk_to_person, complaint).
- **Webhooks**: inbound `webhook_events`; outbound `webhook_endpoints`/`webhook_deliveries`.
- **Audit and support**: `audit_events`, `support_access_grants`.
- **Branches/teams/hours**: `branches` (timezone, address), `teams`, company hours/holidays settings.
- **Design-only** (in `architecture-extension.md`, not built): booking/service job, payment and AI-action state machines, and `outbox_events`. Use these as the starting design but re-specify them against addendum AR-08 (separate quote / booking / delivery / payment).

## 4. Gaps: pure code work vs external dependency

**Pure code work (can be built and tested locally now):**
- Data model and migrations: service locations, service requests/facts, catalogue, rate versions, quotes/versions, acceptances (nonce), native resources/capacity/holds, bookings, external job refs, completion evidence, invoice refs, payment events, reconciliation exceptions, cases, approvals, action attempts, connector inbound ledger, general outbox.
- Deterministic pricing engine with currency minor-unit table and fixtures (AC-04/05).
- Quote and acceptance flow on the customer page with single-use action grants (AC-06, AC-19).
- **Native capacity and holds** with atomic commit (AC-07). This gives a "supported native workflow" so R1 is not blocked on DOP.
- Connector contract (typed schemas, error taxonomy, idempotency, lookup-before-retry) plus a **mock connector isolated from production**, plus contract tests (AC-12, AC-22).
- Payment adapter interface, reconciliation state machine and signed-event verification against recorded fixtures (AC-09–11 at fixture level only; must be labelled simulated).
- Tenant and platform emergency pause, checked in every claim, send and action path (AC-20, FR-23).
- Explicit handback replacing the 24h auto-resume for Operator conversations. Hand-over packet (FR-16).
- Roles: dispatcher, field worker, finance reviewer, auditor (SEC-04).
- Approval queue, exception queue, job timeline, EN/AR screens, currency/PDF output, WCAG 2.2 tags (UX-*).
- Retention purge/export/delete jobs (mechanics only; schedules are an owner decision).
- Eval harness and synthetic Arabic/English fixtures (labelling the data needs people).
- Jitter, circuit breakers, per-tenant fair claiming.

**Needs an external dependency or owner action:**
- **Meta / WhatsApp**: business verification, Tech Provider, Cloud API adapter live test, live template review and pricing (PL-01, PL-02 live, owner-actions 4).
- **Operations backend (DOP / Field Force)**: **no evidence in the repository of any DOP or Field Force API.** The owner must supply API documentation, sandbox credentials and an owner contact. Until then: adapter skeleton, contract tests, disconnected UX, and live verification marked blocked.
- **Payment provider**: merchant account (Moyasar/Tap/HyperPay; requirements in `external-dependencies-and-costs.md`), sandbox keys, webhook secret. A real charge needs owner authorization.
- **Transcription provider** (and optional vision): account, region, cost approval. Nothing in the repository; the AI adapter has never run live either (owner-actions 5).
- **Hosting**: staging/production, secret manager, backups and restore drill (AC-24, RPO/RTO), load test environment (owner-actions 3; `infrastructure/` is empty).
- **Legal/regional**: Business Solution terms (PL-03), PDPL/UAE privacy, ZATCA/VAT treatment for merchants (PL-04), retention schedule (SEC-10), AI disclosure rule (owner-actions 11).
- **People**: native Gulf-Arabic reviewers and consenting voice testers (AI-07), pilot tenant, external security review (owner-actions 7).

## 5. Risks and conflicts with existing behaviour

1. **AI answer mode vs Operator messaging.** In answer mode, `checkAnswer` withholds any text containing booking, confirmation, payment, schedule, technician or "موعد"/"الفني"/"حجز" words, and any price not found verbatim in a cited article (`ai-check.ts` `ACTION_WORDS`, `unsupported_price`). Operator replies about quotes and bookings would always be withheld. Recommended fix: those messages come from deterministic templates filled with confirmed system facts. The AI only extracts and plans. Do not loosen `checks-4` globally.
2. **Automation takeover rules.** New automation runs restart automatically 24h after the last staff reply (`humanQuietHours`), and conversation pauses can expire (`paused_until`). FR-16 requires an explicit, authorized handback. Operator needs its own "case owned by a person" flag that both automations and Operator honour, without changing the existing automation behaviour for non-Operator tenants.
3. **Two engines acting in one conversation.** An Operator case and a messaging automation could both answer the same inbound message (both triggered from the inbound apply transaction). A precedence rule is needed (e.g. an open Operator case suppresses `startAutomationRuns`, recorded as a skip reason).
4. **Customer-link security model.** Today's links are multi-use bearer tokens valid for up to 30 days for a whole contact, and the token stays in the stored outbound message (wave2-report residual M3). Using them directly for acceptance or payment would break FR-08 and SEC-09. An action grant (single-use, short-lived, bound to a quote version) is required. Opening the page must stay read-only.
5. **Disclosure can be turned off** (`ai_settings.disclose`). That conflicts with UX-07 for Operator. Operator should force disclosure, pending owner decision 11.
6. **Consent.** Operator reminders are service messages. Outside 24h they need approved utility templates. Marketing-category templates require `marketing_consent_at`, so a follow-up wrongly categorised as marketing would be blocked or would mis-state consent. No customer quiet-hours check exists in the sender.
7. **No tenant-level stop.** A suspended tenant's queued sends, automations and webhooks are not blocked by the claim functions I read (only customer links and API keys check `tenants.status`). An emergency pause built only for Operator would leave other paths running. Build it once and check it in sender, automation, webhook, push and Operator claims.
8. **Fairness.** Global FIFO claims (`dispatch_claim` orders by `next_attempt_at`) allow one busy tenant to delay others. This affects the reference load target and AC-27.
9. **Naming and table overlap.** `workflow_*` is taken. `usage_events` keys and `audit_events` actions need an Operator namespace. Booking/payment designs in `architecture-extension.md` mix job and payment states in one line, which AR-08 forbids.
10. **Money types.** The only money columns are plan `*_cents int` and AI `cost_usd` numeric. Operator needs per-currency minor units (KWD/BHD/OMR use 3 decimals) and must not reuse USD-numeric AI cost columns for customer amounts.
11. **File-type validation** is by declared MIME only. FR-03 asks for actual-type validation before media reaches transcription or vision.
12. **Unverified items:** per-screen UX-09 states; manual accessibility records; whether any later migration added a tenant-status filter to the claim functions (I read `dispatch_claim` in 0024 and the worker code only); XSS-safe rendering of AI content in the web app; contact merge/unmerge UI.
