# Feature inventory and traceability — BRD v1.1 plus the v1.2 addendum

Prepared 20 Oct 2026 on branch `feature/brd-v1.2-wave1`, starting from `1eac98c` (the tip of `main`). Candidate 3
(`rc3-tested` = `f1bc095`, `rc3-packaged` = `c3b6d3d`) stays frozen and is not changed by anything here.

## How to read the status column

| Code | Meaning |
| --- | --- |
| **VERIFIED-L** | Built, and automated tests pass locally (clean-checkout evidence exists for a named commit) |
| **AWAIT-CI/H** | Built and verified locally; GitHub CI or a hosted check is still needed before it counts as verified |
| **PARTIAL** | Some of the requirement is built; the rest is listed |
| **PLANNED** | In BRD v1.1, not started |
| **NEW** | New in the v1.2 addendum (CF-EXT), not started unless stated |
| **EXT** | Cannot be finished without an outside approval, credential or paid service (named) |

A requirement can carry two codes (for example PLANNED + EXT). Nothing here is "production ready": that needs CI,
hosted verification, an external security review and owner approval.

## 1. BRD v1.1 functional requirements

### Registration, identity and workspace (BRD §5)

| ID | Requirement (short) | Status | Evidence or gap |
| --- | --- | --- | --- |
| FR-001 | Sign-up with verified email, company profile | VERIFIED-L | `auth.test.ts`; clean checkout at `f1bc095`. SSO not built (PLANNED) |
| FR-002 | MFA for privileged roles, recovery codes, sessions, rate limits | VERIFIED-L | `auth.test.ts`, `m7-m9.test.ts`; passkeys later (PLANNED) |
| FR-003 | Workspace, plan, invitations, **connect a channel** | PARTIAL | Workspace, plan and invitations verified. Channel connection: sandbox only in this branch (CF-EXT-001), real Meta connection EXT |
| FR-004 | Subdomain / custom domain | PLANNED + EXT | Slug reserved; domain and TLS need hosting |
| FR-005 | Multiple companies per user, switch clears scope | VERIFIED-L | `isolation.*.test.ts` |
| FR-006 | Profile, hours, holidays, branches, teams, SLA targets | VERIFIED-L | `settings.test.ts`; SLA *timers* belong to the inbox (FR-205) |

### WhatsApp and channel gateway (BRD §6) — maps to CF-EXT-001

| ID | Requirement | Status | Evidence or gap |
| --- | --- | --- | --- |
| FR-101 | Official Cloud API, embedded signup, webhook verification, token lifecycle | PARTIAL (this branch) + EXT | Sandbox adapter with Meta-shaped payloads and HMAC-SHA256 signature check; embedded signup and tokens need Meta Tech Provider status and app review |
| FR-102 | Receive text, media, interactive, contacts, statuses | PARTIAL (this branch) | Text and statuses in slice 1; media download, interactive and contacts cards next |
| FR-103 | Send under platform rules: service window, templates, opt-in | PARTIAL (this branch) | Free-form replies only inside the 24-hour window; outside it refused as `template_required`; opt-out enforced. Template sending: next slice |
| FR-104 | Template drafts, submission, approval status, localisation | PLANNED + EXT | Submission needs a real WhatsApp Business Account |
| FR-105 | Several numbers per company; a number cannot be claimed by two companies | PARTIAL (this branch) | Unique provider number across the platform, enforced in the database |
| FR-106 | Signatures, deduplication, prompt acknowledgement, queue, retries | PARTIAL (this branch) | Signature, deduplication and out-of-order handling done; processing is in-request for slice 1 (see architecture extension, decision AX-3); worker queue and dead-letter next |
| FR-107 | Per-country provider cost tables, usage ledger | VERIFIED-L (tables) / PARTIAL | `provider_rates` and `usage_events` exist (`commercial.test.ts`); not yet linked to sends |
| FR-108 | Opt-out, suppression, consent source and time, complaint handling, throttles | PARTIAL (this branch) | Opt-out keywords (English and Arabic) and consent events; campaign suppression and throttles with CF-EXT-004 |

### Shared inbox (BRD §7) — maps to CF-EXT-002

| ID | Requirement | Status | Evidence or gap |
| --- | --- | --- | --- |
| FR-201 | Realtime inbox, filters, views, search, pagination | PARTIAL (this branch) | List with status and assignment filters and pagination; realtime (SSE) and full-text search next |
| FR-202 | Timeline: messages, media, receipts, assignment history, notes, system events | PARTIAL (this branch) | Messages, receipts, notes and assignment events |
| FR-203 | Assignment: manual, round robin, least busy, skill, hours; concurrency-safe | PARTIAL (this branch) | Manual, concurrency-safe assignment; automatic rules next |
| FR-204 | Notes, quick replies, tags, mentions, snooze, collision prevention, takeover | PARTIAL (this branch) | Internal notes, reply-collision check and supervisor takeover; tags, mentions, snooze, saved replies next |
| FR-205 | SLA clock, escalation, first-response and resolution metrics | PLANNED | Needs FR-201 realtime and the worker |
| FR-206 | Human takeover pauses the bot | PLANNED | With CF-EXT-007/008 |
| FR-207 | Safe uploads: allowlist, ClamAV, signed URLs | VERIFIED-L + AWAIT-CI/H | `scanner.test.ts`; hosted signature freshness pending |

### Contacts, CRM and sales (BRD §8) — maps to CF-EXT-003, 005, 014

| ID | Requirement | Status | Evidence or gap |
| --- | --- | --- | --- |
| FR-301 | Contact profile, identifiers, consent, custom fields, history | PARTIAL (this branch) | Contacts with verified WhatsApp identifier and consent events; custom fields and tags next |
| FR-302 | CSV import/export with validation, duplicates, consent | PLANNED | With CF-EXT-025 |
| FR-303 | Lead pipeline | PLANNED | |
| FR-304 | Bookings | PLANNED | With CF-EXT-017 |
| FR-305 | Web forms, QR / wa.me entry points, tracked sources | PLANNED | Click-to-WhatsApp referral capture is CF-EXT-005 |
| FR-306 | Shopify, WooCommerce, HubSpot, Salesforce, webhook/API | PLANNED + EXT | Partner/app approvals per platform |

### Campaigns and automation (BRD §9) — maps to CF-EXT-004, 007, 019

| ID | Requirement | Status |
| --- | --- | --- |
| FR-401 | Segmentation | PLANNED |
| FR-402 | Template campaigns, preview, schedule, cost estimate, approval | PLANNED (+EXT for live templates) |
| FR-403 | Rate limits, pause/resume, idempotency, statistics, opt-out | PLANNED |
| FR-404 | Rule engine, versioned workflows | PLANNED |
| FR-405 | Automation templates | PLANNED |
| FR-406 | Loop, duplicate and retry protection, trace and cost per run | PLANNED |

### AI agent (BRD §10) — maps to CF-EXT-008, 009, 010, 021

| ID | Requirement | Status |
| --- | --- | --- |
| FR-501–FR-507 | Company AI agent, retrieval, handoff, no invented facts, tool allowlists, injection defence, budgets | PLANNED + EXT (AI provider account and costs) |

### Commercial, console, security (BRD §11–13, §17–18)

| Area | Status | Evidence or gap |
| --- | --- | --- |
| Plans, trial, quotas, seat limits, usage ledger | VERIFIED-L | `limits.test.ts`, `commercial.test.ts` |
| Subscription billing, invoices, dunning, tax | PLANNED + EXT | Payment processor and ZATCA decision |
| Platform console, feature flags, break-glass support access | VERIFIED-L | `platform.test.ts`, `review2.test.ts` |
| Reseller portal | PLANNED | |
| Company isolation (RLS) on every company table, CI guard | VERIFIED-L + AWAIT-CI | `check-rls`, `isolation.db.test.ts`; GitHub CI first run pending |
| Audit trail (append-only, hash chain) | VERIFIED-L | `audit.test.ts` |
| Backups, restore drill, telemetry, uptime | EXT | Hosting decision |
| Penetration test / external security review | EXT | Budget and supplier |

## 2. v1.2 addendum (CF-EXT) — where each item stands

| ID | Title | Related BRD | Status today | Wave |
| --- | --- | --- | --- | --- |
| CF-EXT-001 | Official WhatsApp integration | FR-101–108 | PARTIAL (sandbox slice) + EXT (Meta) | 1 |
| CF-EXT-002 | Shared team inbox | FR-201–206 | PARTIAL (slice) | 1 |
| CF-EXT-003 | Contacts and lightweight CRM | FR-301–304 | PARTIAL (slice: contacts, identifiers, consent) | 1 |
| CF-EXT-004 | Campaigns | FR-401–403, FR-108 | PLANNED | 1 |
| CF-EXT-005 | Advertising attribution | FR-305 | NEW (referral fields stored in slice 1, no reports) | 1 (basic) |
| CF-EXT-006 | Instagram, Messenger, web chat | §14 adapters | NEW + EXT (Meta app review) | 4 (web chat earlier if pilots need it) |
| CF-EXT-007 | Visual flow builder | FR-404–406 | NEW | 2 |
| CF-EXT-008 | Company AI agent | FR-501–505 | PLANNED + EXT | 2 |
| CF-EXT-009 | Agent assistance | — | NEW + EXT (AI provider) | 2 |
| CF-EXT-010 | Gulf Arabic | §16 | NEW (UI Arabic VERIFIED-L; dialect AI needs evaluation set and native reviewers) | 3 |
| CF-EXT-011 | WhatsApp Flows | — | NEW + EXT | 3 |
| CF-EXT-012 | Calling and voice | — | NEW + EXT (availability must be verified per country) | 4 (voice-note transcription earlier) |
| CF-EXT-013 | Agent mobile experience | §14 PWA | NEW (responsive web VERIFIED-L for current screens) | 2 (mobile web), 4 (native) |
| CF-EXT-014 | Commerce (Salla, Zid, Shopify, WooCommerce) | FR-306 | NEW + EXT (partner apps) | 3 |
| CF-EXT-015 | Payments (HyperPay, Moyasar, Tap) | §11, §14 | NEW + EXT (merchant accounts) | 3 |
| CF-EXT-016 | Open integration platform | §14 API | NEW | 2–3 |
| CF-EXT-017 | Maintenance and property package | FR-304 | NEW | 3 |
| CF-EXT-018 | Customer promise tracking | — | NEW | 2 (initial) |
| CF-EXT-019 | Automation rehearsal | FR-406 | NEW | 2 (built with the first automation) |
| CF-EXT-020 | Customer control centre | — | NEW | 2 |
| CF-EXT-021 | Explanations for AI actions | FR-504–505 | NEW | 2 (with the AI agent) |
| CF-EXT-022 | Outcome and cost dashboard | §11 metrics | NEW | 2–3 |
| CF-EXT-023 | Service recovery assistant | — | NEW | 3 |
| CF-EXT-024 | Guided business setup | §16 setup wizard | NEW | 2 |
| CF-EXT-025 | Safe migration and portability | FR-302 | NEW | 2–3 |
| CF-EXT-026 | Security extended to new data | §13 | Ongoing; applied to every slice (slice 1 tables are under RLS and the CI guard) | all |
| CF-EXT-027 | Regional and legal readiness | §13 | PARTIAL (retention policies table exists) + EXT (legal review, Saudi hosting) | 3 |
| CF-EXT-028 | Customer-friendly design | §16 | PARTIAL (current screens: EN/AR, RTL, accessibility checks) | all |

## 3. Things that are built but not yet "verified" in the full sense

| Item | Local | GitHub CI | Hosted | Pilot |
| --- | --- | --- | --- | --- |
| Candidate 3 (`f1bc095`) | Passed (clean checkout, independent review) | Pending (GitHub not linked) | Pending (no hosting) | Pending |
| Preview notice and Netlify config (`34b231a`, `1eac98c`) | Passed (12/12 browser checks) | Pending | Netlify publish blocked (network/GitHub link) | — |
| Slice 1 of this branch | See the report at the end of this branch's work | Pending | Pending | Pending |

## 4. Traceability for slice 1 (filled in as it is built)

| Requirement | Database | API | Tests |
| --- | --- | --- | --- |
| CF-EXT-001 / FR-101, FR-106 | `channel_connections`, `webhook_events` (migration 0022) | `POST /v1/webhooks/sandbox` | `messaging.test.ts`: signature, duplicates, reordering |
| CF-EXT-001 / FR-103, FR-108 | `messages`, `contacts.opted_out_at`, `consent_events` | `POST /v1/conversations/:id/reply` | `messaging.test.ts`: 24-hour window, opt-out keywords, refusal after opt-out |
| CF-EXT-002 / FR-201–204 | `conversations`, `conversation_events`, `internal_notes` | `GET /v1/conversations`, `GET /v1/conversations/:id`, `/assign`, `/notes` | `messaging.test.ts`: assignment race, reply collision, takeover, notes never sent |
| CF-EXT-003 / FR-301 | `contacts`, `contact_identifiers` | via conversations | `messaging.test.ts` |
| CF-EXT-026 | all new tables under forced RLS | — | `check-rls`, cross-company tests in `messaging.test.ts` |
