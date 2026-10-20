# Implementation backlog — BRD v1.2

Prepared 20 Oct 2026. Effort is in **developer-days for this build process**, as planning estimates, not quotes.
Operating cost is the monthly cost once live, where known (`external-dependencies-and-costs.md`). Status codes as in
`feature-inventory-and-traceability.md`. Candidate 3 stays frozen; everything here lands on feature branches.

## Reconciled order

The owner's four waves fit the existing BRD phases: Wave 1 ≈ BRD Phase 1 remainder + Phase 2 start; Wave 2 ≈ Phase 2–3;
Wave 3 ≈ Phase 3 plus GCC items; Wave 4 later. Two items move earlier because pilots need them: **mobile web for
agents** (Wave 2, not 4) and **automation safety controls** (built with the first automation, never last).

## Wave 1 — revenue-ready WhatsApp foundation

| # | ID | User story | Depends on | Priority | Data / API / screens | Permissions and audit | Acceptance and tests | Effort | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W1.1 | CF-EXT-001/002/003 | As an agent, I see customer WhatsApp messages in one inbox and reply safely | — | P0 | Migration 0022; `/v1/channels`, `/v1/webhooks/sandbox`, `/v1/conversations…` | `channels.manage` (MFA), `inbox.reply`, `inbox.read_all`, `inbox.assign`; audit: channel connected, assigned, takeover, opt-out/in | Acceptance 1, 2, 6, 9; `messaging.test.ts` (22), isolation test | 3 | **Built** (slice 1, commit `3c6d20d`), review pending |
| W1.2 | CF-EXT-002 | As an agent, I use an inbox screen in English or Arabic on desktop and phone | W1.1 | P0 | Web: inbox list, conversation view, reply box with clear errors (window closed, opted out, changed) | Same as W1.1 | Acceptance 2, 7; browser checks EN/AR × 3 sizes, accessibility | 3 | Planned |
| W1.3 | AX-3 | As an owner, I lose no message if a server restarts | W1.1 | P0 | Outbox table, worker consumer, dead letters, replay (platform console), send retries with the same idempotency key | Replay: platform owner only, audited | Acceptance 1, 8; crash/restart and duplicate tests | 3 | Planned |
| W1.4 | CF-EXT-001 | As an agent, I see photos, documents and voice notes, and can send them | W1.1, W1.3 | P0 | Media download via provider, ClamAV scan, signed links (reuse FR-207) | `files.*` | Malware and isolation tests | 2 | Planned |
| W1.5 | CF-EXT-001 / FR-104 | As an owner, I manage message templates and send one outside the 24-hour window | W1.1 | P0 | `templates`, `template_versions`; status sync; sandbox approval simulation | `templates.manage` (new); audit | Window and category tests; opt-out reuse | 3 | Planned (+EXT for real approval) |
| W1.6 | CF-EXT-002 | As a supervisor, I use teams, tags, saved replies, SLA timers and automatic assignment | W1.2 | P1 | Assignment rules (round robin, least busy, hours); SLA clocks in the worker | `inbox.assign`; audit rule changes | SLA timing tests in company time zones | 4 | Planned |
| W1.7 | CF-EXT-003 / FR-302 | As an owner, I import contacts from CSV with duplicate review and consent | W1.1 | P1 | Import batches, dry run, error report, reversible batch | `contacts.write`; audit | Duplicate and consent tests | 3 | Planned |
| W1.8 | CF-EXT-004 | As a marketer, I send a campaign only to consenting contacts, with cost shown first | W1.5, W1.7 | P0 | Audiences, campaigns, recipients, suppression, frequency caps; cost estimate from `provider_rates` | `campaigns.manage` (new, MFA); approval step; audit | Acceptance 6; idempotent send, pause/resume tests | 4 | Planned |
| W1.9 | CF-EXT-005 | As an owner, I see which ads brought conversations | W1.1 | P1 | Referral fields (stored since slice 1); report | `reports.read` | Attribution window shown; unattributed shown | 1 | Partial (data stored) |
| W1.10 | CF-EXT-001 | As an owner, I connect my real WhatsApp number | Meta Tech Provider approval | P0 | Embedded Signup **v4** (v2/v3 deprecated 15 Oct 2026), token exchange, number registration, webhook subscription, Cloud API adapter | `channels.manage` | Hosted test with a real test number | 3 | **EXT** — blocked on Meta |
| W1.11 | FR-107 | As an owner, I see what messages cost | W1.10 | P1 | Usage ledger linked to sends; read `pricing.type/category` from status webhooks; rates loaded from Meta's rate card, dated | `billing.read` | Charges never duplicated (acceptance 1) | 2 | Partial |

**Wave 1 total:** about 31 developer-days of local build, plus the Meta-dependent item. Operating cost when live:
messaging fees (paid by each customer to Meta), hosting (on hold).

## Wave 2 — usable automation and customer experience

| # | ID | Summary | Effort | Notes |
| --- | --- | --- | --- | --- |
| W2.1 | CF-EXT-007, 019 | Workflow engine with versions, run pinning, loop/duplicate protection, **rehearsal mode built in from the start**; visual builder plus accessible list editor | 10 | Acceptance 4, 10 |
| W2.2 | CF-EXT-008, 021 | AI agent with company knowledge, tools for facts/actions, approval gates, action explanations, budgets | 8 | **EXT**: AI provider account and costs; acceptance 5 |
| W2.3 | CF-EXT-009 | Agent assistance: translation (original kept), summaries, suggested replies | 3 | EXT: AI provider |
| W2.4 | CF-EXT-020 | Customer control centre (expiring, revocable links) | 4 | Acceptance 3, 9 |
| W2.5 | CF-EXT-013 | Mobile web for agents, push notifications (web push), queued-action display | 4 | Native apps in Wave 4 |
| W2.6 | CF-EXT-018 | Promise tracking (manual and rule-based first; AI suggestions after W2.2) | 3 | |
| W2.7 | CF-EXT-024 | Guided setup, sample workspace (clearly labelled), Arabic/English templates | 3 | |
| W2.8 | CF-EXT-016 | Public API v1 with scoped keys, webhooks out, rate limits, logs; Zapier/Make via API | 5 | Marketplace listings EXT |
| W2.9 | CF-EXT-022 | Outcome and cost dashboard (first version) | 3 | |

## Wave 3 — GCC differentiation

| # | ID | Summary | Effort | Notes |
| --- | --- | --- | --- | --- |
| W3.1 | CF-EXT-014 | Salla and Zid apps (orders, products, abandoned carts), then Shopify/WooCommerce | 8 | **EXT**: partner accounts and app review (Salla scrutinises communication/AI apps) |
| W3.2 | CF-EXT-015 | Payment links and hosted checkout (Moyasar, Tap, HyperPay adapters); reconciliation | 6 | **EXT**: merchant accounts; WhatsApp native payments are not offered in KSA/UAE per Meta's docs |
| W3.3 | CF-EXT-017 | Maintenance and property package | 12 | Modular; acceptance 3, 5, 8 |
| W3.4 | CF-EXT-010 | Gulf-dialect evaluation set and native-speaker review | 4 + reviewers | **EXT**: reviewers |
| W3.5 | CF-EXT-023 | Service recovery assistant | 3 | |
| W3.6 | CF-EXT-011 | WhatsApp Flows (encrypted data endpoint) | 4 | EXT: live number |
| W3.7 | CF-EXT-027 | Retention/export/deletion workflows, subprocessor register, Saudi hosting option design | 4 | **EXT**: legal review, hosting |
| W3.8 | CF-EXT-025 | Migration and portability tools | 3 | |

## Wave 4 — broader reach

Instagram and Messenger (W4.1, 5 days, EXT app review); website chat widget (W4.2, 4 days; earlier if pilots need it);
native mobile apps (W4.3, 10+ days, EXT store accounts); WhatsApp calling and AI voice (W4.4, after Saudi/UAE
availability is verified in-market); further CRM integrations (W4.5).

## Definition of done for every item

- Requirement ID, user story and acceptance criteria written before code.
- Migrations backward-compatible; new tables under forced RLS and in the isolation test.
- Permissions checked on the server; audit events for sensitive actions.
- Tests run and recorded with the commit, environment and workload.
- Screens reviewed in English and Arabic at three sizes; no dead buttons; demo data labelled.
- Independent review for security-relevant changes; findings fixed and rechecked.
- Local, CI, hosted and pilot evidence reported separately.
