# Acceptance matrix — BRD v1.2 minimum acceptance

Each item lists how it is proved and where it stands, with **local, CI, hosted and pilot evidence kept separate**.
"Local" means a named commit passed in the local harness (PostgreSQL 16, Redis 7, ClamAV with the test signature,
restricted database roles, Chromium for browser checks). Updated 20 Oct 2026 for slice 1 (`3c6d20d`, fixes `1665c0f`) and slice 2 (`138869e`, review fixes `e3c49dc`, `1c3854c`, `4eda821`; reviewed and rechecked) and slice 3 (`571abe4`, fixes `cbc2f7f`, `0de62ee`, `dcece7b`; reviewed and rechecked). Updated 21 Oct 2026 for slice 4 (`264379b`, fixes `294a79d`, `074644f`, closure `a061494`, `b1a03bb`, `ffdc5c7`; reviewed and rechecked; see `wave1-slice4-report.md`). Updated 22 Oct 2026 for W1.14 (`0522bb3`) and slice 5 (`6b6b255`, fixes `add9cc9`, `0390c13`; reviewed and rechecked twice; see `wave1-slice5-report.md`).

## Where things stand after Wave 1 slice 5 (22 Oct 2026; code at `0390c13`)

All "complete" items below are **local verification only**: simulated WhatsApp (sandbox provider) and ClamAV with its
test signature. None of them has been checked against live WhatsApp, Meta's template review, current virus definitions,
GitHub CI or a hosted environment.

**Complete locally (tested at a named commit, independently reviewed and rechecked)**

| Area | What is complete | Last verified |
| --- | --- | --- |
| Messaging core | Inbound and outbound messages; duplicate and reordered webhooks; forward-only statuses; conflicting replies prevented | Slice 1–2 evidence; still passing at `0390c13` |
| Sending reliability | Queued → submitting before the call; confirmed failure vs uncertain kept apart; failure wording from recorded per-attempt evidence; late answers recorded without resending or lowering a status; exact message matching (simulated) | `ffdc5c7`; still passing at `0390c13` |
| Retries | Colleague retry with send-time checks; one retry per chain (database-enforced); replies vs approved templates outside the 24-hour window; campaign messages not retried individually | `ffdc5c7`; still passing at `0390c13` |
| Opt-outs and consent | One check for every outbound route, at queue and send time; marketing consent with evidence; STOP withdraws it | `ffdc5c7`; still passing at `0390c13` |
| Templates and media | Template lifecycle by business account (simulated review); media download, malware scan (test signature) and per-company storage; 16 MB limit shown and enforced | `ffdc5c7`; still passing at `0390c13` |
| Campaigns | Audience preview, recorded consent, suppression list, scheduling, frequency and daily limits checked at queue time and atomically at send time, cost estimate (estimated / unavailable / no cost), pause, resume, cancel; no duplicate sending under duplicate jobs, crashes, partial failures and concurrent senders | `ffdc5c7`; still passing at `0390c13` |
| Permissions upgrade (SR-1) | Built-in roles of existing companies get exactly the later permissions; custom roles untouched | `ffdc5c7`; still passing at `0390c13` |
| Company isolation | Forced row security on every company table including the new campaign tables; reviewed cross-company lookups pinned by the guard | `ffdc5c7`; still passing at `0390c13` |
| Screens | English and Arabic at three sizes for the inbox, templates, channel health and campaigns pages (Chromium) | `ffdc5c7`; still passing at `0390c13` |
| Contacts (slice 5) | Contact import with preview, phone validation, opt-in evidence, no re-consent after an opt-out or withdrawal, undo that keeps anything with its own history; contact list limited to what each person may see | `0390c13` |
| Inbox tools (slice 5) | Tags and tag filter with history; saved replies in English and Arabic; automatic assignment in turn, optionally within business hours, safe under simultaneous arrivals | `0390c13` |
| Campaign report (W1.14) | Recipients skipped at send time shown with count and reason, separate from delivery results | `0522bb3`; still passing at `0390c13` |

**Remaining (not built, or open)**

| Item | Status |
| --- | --- |
| G4 (migrations run by the database owner) and the sign-in risk | Open; owner acceptance pending. Not accepted |
| Contact import with opt-in evidence, tags and saved replies, automatic assignment | Built in slice 5 (22 Oct 2026, local only; see `wave1-slice5-report.md`). Analysts' contact visibility kept restricted (owner decision 22 Oct 2026) |
| Usage and cost ledger, Click-to-WhatsApp ad reports | Remaining Wave 1 work |
| Inbound events applied by the worker instead of in the request (AX-3) | Open; before live traffic and live campaigns |
| Verified Meta marketing rates for Saudi Arabia and the UAE | Open; the estimate stays "unavailable" until they are checked and recorded with their date |
| Larger documents than 16 MB (W1.13) | Later enhancement, after storage costs and hosting are approved |
| Frequency at send time (P2-3) | Decided 21 Oct: skip, never send later; skipped count and reason shown in the campaign report (W1.14, `0522bb3`) |
| B-2 (Low, not probed): upgrade from a database that ran migrations 0032–0035 with campaign traffic could undercount | Open; no such database exists. Must be tested before upgrading any persistent database with campaign traffic |
| Firefox and WebKit browser runs; real devices | Not run yet |
| Wave 2 items (workflows, AI, customer links, rehearsals) | Not built |

**Needs hosted or live verification before pilot**

| Item | Why it cannot be closed locally |
| --- | --- |
| GitHub CI run of the same checks | Needs the company-owned private repository and spending controls confirmed |
| Hosted run (backend, database, scanner with current definitions) | No hosting approved |
| Message-ID correlation: our reference (`biz_opaque_callback_data`) returned in status updates; one WhatsApp id per accepted send | Simulated only; confirm with a Meta test number |
| Template review, provider acceptance and delivery statuses | Simulated only |
| Malware scanning with current official definitions | Test signature only locally |
| Send idempotency on WhatsApp's endpoint | Not verified in the sources checked |
| Each number's real messaging tier (daily limit default 250) | Not read from Meta yet |
| Load, soak and availability targets | Need the pilot environment |

## Acceptance items

| # | Acceptance item | How it is proved | Local | CI | Hosted | Pilot |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Duplicate or reordered webhooks do not duplicate business actions | Unique key per provider event and per provider message; forward-only statuses; orphan statuses applied later. Tests: repeated delivery, reversed message order, late "delivered" after "read", status before send | **Passed for messages and statuses** at `1665c0f` (clean checkout; reviewed and rechecked). Charges: not built Slice 4 (local): campaigns queue each recipient once (one recipient per contact, recipient id as idempotency key, one transaction); duplicate runners, a mid-batch crash and partial failures tested; late provider answers matched to the exact message by our reference or the provider id | Pending | Pending (needs Meta test number) | Pending |
| 2 | Two agents cannot unknowingly send conflicting replies | Reply names the conversation's arrival counter as the agent saw it, checked under a row lock (a late customer message also bumps it); assignment by version; takeover explicit. Tests: simultaneous replies (exactly one sent), stale view refused, simultaneous claims (one wins), takeover required | **Passed** at `1665c0f`, including a late customer message (review M1) | Pending | Pending | Pending |
| 3 | Revoked access stops working through APIs, downloads and customer links | Existing: membership removal, file-link revocation (`isolation.api.test.ts`). Customer links: Wave 2 | Passed for members and files (Candidate 3); customer links not built | Pending | Pending (file revocation hosted check ready) | Pending |
| 4 | Published workflow versions are reproducible and recoverable | Version pinning and rollback tests | Not built (Wave 2) | — | — | — |
| 5 | AI cannot invent confirmed prices, bookings, refunds or payment success | Tool-only facts, confirmation states, adversarial tests including prompt injection | Not built (Wave 2) | — | — | — |
| 6 | Opt-outs and contact preferences are enforced consistently | One consent check used by every outbound route; English and Arabic keywords; append-only evidence. Tests: STOP/إيقاف blocks replies; sentence containing "stop" does not; START re-enables | **Passed for replies and at send time** at `4eda821` (emoji/punctuation/Arabic normalisation, queued message stopped by a later opt-out). Templates and campaigns will reuse the check Slice 3 (`dcece7b`, local): templates refused for opted-out contacts; marketing templates need recorded marketing consent, withdrawn by STOP; all re-checked at send time. Slice 4 (local, `ffdc5c7`): campaigns check opt-out, consent, suppression list, frequency and daily limits when queueing and again just before sending (limits atomically), including opt-outs and suppressions received after scheduling or queueing. Slice 5 (local, `0390c13`): imports record marketing consent only with the company's evidence and never for someone who opted out or withdrew | Pending | Pending | Pending |
| 7 | Arabic and English journeys work on mobile and desktop | Browser checks in both languages at three sizes, accessibility rules | Inbox screen passes EN/AR at three sizes, accessibility scan, no clipped text, no CSP violations (14/14 at `4eda821`, Chromium) Slice 3 (`dcece7b`, local): template composer, media, Templates and Channel health pages pass EN/AR at three sizes (15/15). Slice 4 (local): Campaigns page EN/AR at three sizes; sandbox and scanner labels; 16 MB limit shown. Slice 5 (local, `0390c13`): Contacts and Inbox setup pages, tag chips and saved replies EN/AR at three sizes | Pending (Firefox/WebKit first run) | Pending (real devices) | Pending |
| 8 | Failed integrations show accurate status and safe retry options | Provider refusal recorded as failed with the provider's code; retries keep the same idempotency key | **Passed** at `4eda821` (local, reviewed): refusal shown as failed with reason; busy provider retried with back-off then failed after 5 attempts; unknown outcome shown as uncertain and never resent automatically; manual retry needs confirmation for uncertain; crash before/after submission recovered. Provider health view not built Slice 3 (`dcece7b`, local): every failure carries how it is known (blocked, rejected, exhausted, provider-reported); uncertain kept separate; colleague retry with send-time checks and a database-enforced chain limit; channel health and recovery that cannot send. Slice 4 (local): per-attempt evidence; "declined on each of 5 attempts" only with five recorded refusals and nothing ambiguous, otherwise uncertain; late answers recorded without resending or lowering a status; retry eligibility differs for replies and approved templates outside the 24-hour window. All against the simulated provider | Pending | Pending | Pending |
| 9 | Customer and company boundaries hold across every new storage and processing route | CI guard; isolation test over every company table (now including the nine messaging tables); API tests across companies; webhook routing by number only | **Passed** at `1665c0f` (company level; guard pins `cf_channel`; general guard rule open, Low). Contact-level boundaries inside a company: with the customer control centre Slice 3 (`dcece7b`, local): templates routed by business account through a reviewed lookup; media stored per company after a malware scan; guard extended to all schemas, partitioned and foreign tables, untagged tables and setting defaults; upgrade with data tested. Slice 4 (local): campaign tables under forced row security; `campaign_claim` lookup pinned; SR-1 upgrade tested with custom roles untouched. Slice 5 (local, `0390c13`): new tables under forced row security; `import_previews_expire` lookup pinned and limited to expired previews | Pending | Pending | Pending |
| 10 | Rehearsals cannot affect live systems | Rehearsal runs with recording adapters only; database flag; tests that no live adapter is reachable | Not built (Wave 2, with the first automation) | — | — | — |

## Targets to set before each wave is implemented

| Area | Proposed target | Measured how |
| --- | --- | --- |
| Inbox usability | A new agent replies to a first conversation within 2 minutes without help, in Arabic or English | Moderated test with 5 pilot users per language |
| Owner setup | A non-technical owner connects a channel and sends a first reply within 30 minutes | Pilot onboarding sessions |
| Webhook intake | p95 under 300 ms per delivery at 50 deliveries/second on the pilot server | Load test, environment recorded |
| Inbox reads | p95 under 500 ms for the conversation list at 2,000 agents' worth of data (BRD §17) | Load test |
| Reliability | No lost or duplicated message in a 24-hour soak with injected restarts and duplicate deliveries | Soak test in staging |
| Availability | 99.9% monthly after general availability (BRD §17) | Independent uptime monitor |

These are proposals for the owner to confirm; results will always state the environment and workload behind them.
