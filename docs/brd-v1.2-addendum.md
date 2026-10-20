# ConversaFlow BRD v1.2 — addendum (proposed)

Status: **proposed**, received from the owner on 20 Oct 2026 as an addendum and implementation instruction. It extends
BRD v1.1 without renumbering it: existing requirements keep their FR identifiers, new ones use **CF-EXT-001 to
CF-EXT-028**. Where an addendum item overlaps a v1.1 requirement, both identifiers are shown.

## Vision

A WhatsApp-first customer engagement and service-operations platform for small and growing businesses, starting in
Saudi Arabia and the GCC, built so it can expand internationally.

The product helps a business win customers, answer questions, complete sales and deliver services. Success means
the customer gets the issue resolved or the purchase completed with less effort, and the owner can see the outcome
and what it cost.

**Benchmarks:** Wati for the core buying decision, respond.io for advanced conversation management
(`competitive-evidence.md`). ConversaFlow aims to win on Arabic usability, service delivery, trustworthy automation
and customer experience. Evidence gathered on 20 Oct 2026 shows that respond.io already offers a full Arabic
interface, so Arabic support must be paired with Gulf commerce and service-delivery strengths to stand out.

## Guardrails carried forward

- Candidate 3 (`rc3-tested`, `rc3-packaged`) and its evidence stay frozen. New work happens on separate branches and
  commits.
- Company isolation, permissions, two-step sign-in, audit controls, pricing rules and recovery protections are kept
  and extended to every new table, queue, cache, index, file, export and AI retrieval (CF-EXT-026).
- No residual risk is accepted on the owner's behalf. Open risks are recorded with acceptance pending.
- This addendum authorises development and local testing. It does not authorise purchases, production changes,
  external messages, new deployments or a push to an unconfirmed repository. Earlier approvals keep their scope.

## Requirements

The full text of each requirement is the owner's instruction of 20 Oct 2026. In short:

### Messaging, CRM and growth (competitive baseline)
| ID | Title | Related v1.1 |
| --- | --- | --- |
| CF-EXT-001 | Official WhatsApp integration: onboarding, health, messages, media, templates, receipts, errors; windows, templates, consent and opt-outs per Meta's current rules; server-side credentials; verified, de-duplicated, order-tolerant webhooks | FR-101–108 |
| CF-EXT-002 | Shared inbox: assignment to agents, teams and branches; collision detection; notes, mentions, tags, saved replies; hours, SLA, escalation, supervisor views; search; clear AI-to-human ownership; visible "talk to a person" route | FR-201–206 |
| CF-EXT-003 | Contacts and light CRM: profiles, custom fields, segments, pipelines, tasks, bookings, CSV, duplicate review; cross-channel timeline; no merging on names alone; auditable merge and unmerge | FR-301–304 |
| CF-EXT-004 | Campaigns: audience preview, segments, scheduling, time zones, suppression, frequency caps, consent checks, analytics; estimated cost and eligibility shown as estimates before launch | FR-401–403 |
| CF-EXT-005 | Ad attribution: Click-to-WhatsApp referral data; ad → conversation → lead → booking/order → outcome; model and window shown; no claim of incremental revenue | FR-305 |
| CF-EXT-006 | Instagram, Messenger and website chat in the same inbox; channel capability matrix; adapters for later channels; web chat with domain controls, abuse protection, accessibility, safe sessions | BRD §14 |

### Automation and AI
| ID | Title | Related v1.1 |
| --- | --- | --- |
| CF-EXT-007 | Visual flow builder with an accessible list alternative; triggers, conditions, messages, templates, forms, delays, hours, assignment, CRM updates, AI and human-approval steps, integrations, error branches; templates, draft/publish, versions, validation, logs, rollback; loop and duplicate protection; runs pinned to their starting version | FR-404–406 |
| CF-EXT-008 | Company AI agent: company-scoped knowledge, instructions, handoff, multilingual; facts about prices, availability, orders, bookings, refunds only from systems of record; distinguishes answer / suggestion / permitted action / human needed; never claims success without a confirmed result | FR-501–505 |
| CF-EXT-009 | Agent assistance: translation (original kept), summaries, suggested replies, tone, extraction; editable, uncertainty labelled; summary at handoff | — |
| CF-EXT-010 | Gulf Arabic: MSA, Gulf dialects, code-switching, names, mixed direction, local formats; evaluation set with native-speaker review; measure task completion and critical errors | BRD §16 |
| CF-EXT-011 | WhatsApp Flows for bookings, quotes, service requests, surveys, lead qualification; server-side validation, expiry, resume, accessible fallback | — |
| CF-EXT-012 | Calling and voice: plan only until provider capability, country availability, permissions, recording rules and costs are verified; voice-note transcription first | — |

### Mobile, commerce and integrations
| ID | Title |
| --- | --- |
| CF-EXT-013 | Agent mobile: responsive web first, shared-code native app when justified; push, replies, media, notes, handoff, supervisor alerts; protected notification content, device revocation, minimal local storage, visible queued actions, no duplicate sends after reconnecting; store accounts need separate approval |
| CF-EXT-014 | Commerce: WhatsApp catalog and supported checkout; Salla and Zid first, then Shopify and WooCommerce; products, stock, orders, cart recovery, fulfilment, cancellations, returns and refunds where APIs allow; a stated system of record and conflict rules per integration |
| CF-EXT-015 | Payments: evaluate HyperPay, Moyasar, Tap; Apple Pay where permitted; hosted or tokenised checkout only, never stored cards; payment links distinguished from native in-chat payments; trust signed events and reconciliation, not return URLs; duplicates, failures, refunds, disputes |
| CF-EXT-016 | Open platform: versioned public API, scoped credentials, documented webhooks, pagination, rate limits, logs; Zapier and Make first; staged CRM integrations; signatures, retries, idempotency, secret rotation, controlled replay; AI tools (including MCP) under the same permissions and audit |

### Service operations
| ID | Title |
| --- | --- |
| CF-EXT-017 | Maintenance and property package: report (text, photo, voice, location) → service request → triage → quote or booking → technician → updates → completion → invoice/payment → feedback; property, unit, asset and history; assignment by priority, skill, territory, availability; customer approvals; arrival windows vs confirmed ETAs; checklists and evidence; repeats, warranty, complaints; recurring maintenance; landlord, tenant and manager permissions; modular |

### Differentiators to build and validate (not to be advertised as "unavailable elsewhere" without evidence)
| ID | Title |
| --- | --- |
| CF-EXT-018 | Customer promise tracking: commitments become tracked promises with owner, deadline, source and status; AI may suggest, a person or approved rule confirms; warnings before misses |
| CF-EXT-019 | Automation rehearsal: sandbox runs of workflows and AI with simulated duplicates, mixed language, missing data, unhappy customers, payment failures, expired consent, no technician; shows replies, actions, permissions, cost and failure paths; never touches live systems |
| CF-EXT-020 | Customer control centre: secure page for status, appointments, quotes, payments, documents, preferences, consent, complaints, human request; expiring, revocable access; customer-level ownership |
| CF-EXT-021 | Explanations for AI actions: sources, policy/workflow version, proposed and executed action, approval, provider result, cancellability; no private model reasoning or secrets |
| CF-EXT-022 | Outcome and cost dashboard: bookings, orders, resolutions, repeat contacts, satisfaction, cost per completed outcome; AI vs human split; assumptions visible; gross and net of refunds |
| CF-EXT-023 | Service recovery assistant: explainable signals for missed promises, repeat contact, failed fulfilment; policy-approved remedies; monetary remedies within configured limits; sentiment advisory only |
| CF-EXT-024 | Guided setup: Arabic and English industry templates, sample workspace, first-value checklist, help; plain-language workflow description becomes an inspectable, testable draft |
| CF-EXT-025 | Migration and portability: mapping, dry runs, duplicate review, error reports, reversible batches; exports of contacts, conversations, consent and records; honest about what other platforms let you export |

### Trust, regional readiness and usability
| ID | Title |
| --- | --- |
| CF-EXT-026 | Security across every new storage and processing route, including contact-level access inside a company |
| CF-EXT-027 | Regional and legal readiness: retention, deletion/export, consent evidence, subprocessors, regional hosting (a Saudi option covers databases, files, backups, logs, analytics, AI providers and support access); PDPL with qualified review; ZATCA as a separate verified integration, distinguishing ConversaFlow's own invoices from merchants' |
| CF-EXT-028 | Customer-friendly design: full English and Arabic, RTL, keyboard, WCAG 2.2 AA target; clear loading, empty, error, retry and offline states; plain labels; no dead buttons or false success; demo data and mock integrations visibly labelled |

## Engineering requirements (summary)

Extend the current TypeScript architecture; no microservices or new infrastructure for its own sake. Required:
backward-compatible migrations; explicit state machines (workflows, bookings, payments, handoffs); reliable event
publication; idempotent consumers with bounded retries; dead letters and safe replay; timeouts, circuit breakers and
provider health; company-scoped, redacted logs, metrics and traces; feature flags with company-level rollout; AI
model/provider version tracking and evaluation; budget limits and graceful degradation; backup and restore
verification once hosted. Uploaded content, retrieved documents and external messages are untrusted and can never
grant AI tools new permissions. Design detail: `architecture-extension.md`.

## Build order

Wave 1 revenue-ready WhatsApp foundation → Wave 2 usable automation and customer experience → Wave 3 GCC
differentiation → Wave 4 broader reach. Safety controls for automation (rehearsal, AI action controls) are built
with the first automation features, not deferred. Detail: `implementation-backlog.md`.

## Minimum acceptance (all waves)

The ten acceptance items in `acceptance-matrix.md`, each with the tests and evidence that prove it, the environment
it ran in, and whether it is local, CI, hosted or pilot evidence.
