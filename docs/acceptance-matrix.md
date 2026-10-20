# Acceptance matrix — BRD v1.2 minimum acceptance

Each item lists how it is proved and where it stands, with **local, CI, hosted and pilot evidence kept separate**.
"Local" means a named commit passed in the local harness (PostgreSQL 16, Redis 7, ClamAV with the test signature,
restricted database roles, Chromium for browser checks). Updated 20 Oct 2026 for slice 1 (`3c6d20d`, fixes `1665c0f`) and slice 2 (`138869e`, review pending).

| # | Acceptance item | How it is proved | Local | CI | Hosted | Pilot |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Duplicate or reordered webhooks do not duplicate business actions | Unique key per provider event and per provider message; forward-only statuses; orphan statuses applied later. Tests: repeated delivery, reversed message order, late "delivered" after "read", status before send | **Passed for messages and statuses** at `1665c0f` (clean checkout; reviewed and rechecked). Charges and campaigns: not built | Pending | Pending (needs Meta test number) | Pending |
| 2 | Two agents cannot unknowingly send conflicting replies | Reply names the conversation's arrival counter as the agent saw it, checked under a row lock (a late customer message also bumps it); assignment by version; takeover explicit. Tests: simultaneous replies (exactly one sent), stale view refused, simultaneous claims (one wins), takeover required | **Passed** at `1665c0f`, including a late customer message (review M1) | Pending | Pending | Pending |
| 3 | Revoked access stops working through APIs, downloads and customer links | Existing: membership removal, file-link revocation (`isolation.api.test.ts`). Customer links: Wave 2 | Passed for members and files (Candidate 3); customer links not built | Pending | Pending (file revocation hosted check ready) | Pending |
| 4 | Published workflow versions are reproducible and recoverable | Version pinning and rollback tests | Not built (Wave 2) | — | — | — |
| 5 | AI cannot invent confirmed prices, bookings, refunds or payment success | Tool-only facts, confirmation states, adversarial tests including prompt injection | Not built (Wave 2) | — | — | — |
| 6 | Opt-outs and contact preferences are enforced consistently | One consent check used by every outbound route; English and Arabic keywords; append-only evidence. Tests: STOP/إيقاف blocks replies; sentence containing "stop" does not; START re-enables | **Passed for replies and at send time** at `138869e` (emoji/punctuation/Arabic normalisation, queued message stopped by a later opt-out). Templates and campaigns will reuse the check | Pending | Pending | Pending |
| 7 | Arabic and English journeys work on mobile and desktop | Browser checks in both languages at three sizes, accessibility rules | Inbox screen passes EN/AR at three sizes, accessibility scan, no clipped text, no CSP violations (14/14 at `138869e`, Chromium) | Pending (Firefox/WebKit first run) | Pending (real devices) | Pending |
| 8 | Failed integrations show accurate status and safe retry options | Provider refusal recorded as failed with the provider's code; retries keep the same idempotency key | **Passed** at `138869e` (local, review pending): refusal shown as failed with reason; busy provider retried with back-off then failed after 5 attempts; unknown outcome shown as uncertain and never resent automatically; manual retry needs confirmation for uncertain; crash before/after submission recovered. Provider health view not built | Pending | Pending | Pending |
| 9 | Customer and company boundaries hold across every new storage and processing route | CI guard; isolation test over every company table (now including the nine messaging tables); API tests across companies; webhook routing by number only | **Passed** at `1665c0f` (company level; guard pins `cf_channel`; general guard rule open, Low). Contact-level boundaries inside a company: with the customer control centre | Pending | Pending | Pending |
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
