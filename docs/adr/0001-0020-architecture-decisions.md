# Architecture decision records (ADR-001 to ADR-020)

Status: **Accepted for Phase 1** on 19 Oct 2026, with the owner's decisions recorded in ADR-021. Each record:
context → decision → consequence. Details and rejected alternatives are in the plan document.

| ADR | Decision | Consequence |
| --- | --- | --- |
| 001 | Modular monolith: one NestJS codebase run as API and worker; Next.js web app | One deployable; modules split out later only when load requires |
| 002 | TypeScript everywhere; pnpm workspaces + Turborepo | Shared types; one CI pipeline |
| 003 | Shared database, shared schema, `tenant_id` + **forced** RLS on every company table | DB enforces isolation; database-per-tenant stays an Enterprise option |
| 004 | API connects as `cf_app` (no ownership, no BYPASSRLS); each request = one transaction with transaction-local `app.tenant_id` / `app.user_id` | A missing `WHERE` returns nothing, never another company's rows |
| 005 | Platform-owner access to customer content only via audited, time-limited break-glass grants | Implemented in M1.6 |
| 006 | Plain SQL migrations (RLS, roles, functions explicit and reviewable). Queries via `pg` with parameters; Drizzle may be added for typed queries later | Migration files are immutable once applied (checksum enforced) |
| 007 | UUIDv7 primary keys | Not enumerable; index-friendly |
| 008 | BullMQ on Redis fed by a transactional outbox (Phase 2) | No lost or phantom jobs |
| 009 | Realtime rooms joined only after server-side permission check (Phase 2) | Realtime cannot leak across companies |
| 010 | Auth built in-house: Argon2id, opaque server sessions in httpOnly cookies, TOTP MFA + recovery codes | Meronatic owns identity data; no per-user vendor fee |
| 011 | REST `/v1`, contracts in `packages/contracts` (Zod) | One schema validates server input and types the client |
| 012 | `ChannelProvider` interface; WhatsApp Cloud API adapter + local mock (Phase 2) | Build and test without real Meta assets |
| 013 | Object storage keys `tenants/{tenant_id}/files/{file_id}`; DB check constraint ties key to company; short-lived signed links bound to user + company | Files isolated three ways |
| 014 | Provider-neutral AI gateway; embeddings under the same RLS (Phase 4) | Same isolation for AI data |
| 015 | `PaymentProvider` interface; prices, taxes and limits in our database | Live payments deferred to Phase 5 (approved) |
| 016 | Next.js + Tailwind logical properties + Radix; next-intl EN/AR; Inter + IBM Plex Sans Arabic (pending approval) | RTL from day one |
| 017 | Hosting: managed cloud, separate staging and production accounts, Terraform | **Provisional EU region**; no commitment until costs, data requirements and migration options are confirmed |
| 018 | OpenTelemetry, structured logs, no message content in logs | Tenant-safe observability |
| 019 | Tests run against real PostgreSQL and Redis (no mocked database for isolation tests) | RLS is genuinely exercised |
| 020 | GitHub Actions: lint, build, type-check, dependency audit, secret scan, migrations, isolation check, tests | Evidence for every change |

## ADR-021 — Owner decisions of 19 Oct 2026

1. **Contracting entity:** jurisdiction **Dubai**; exact legal name pending verification against incorporation
   documents. Not assumed in code, configuration or legal text until verified.
2. **Hosting:** EU as a provisional planning assumption only.
3. **GitHub:** organisation and private repository must be Meronatic-owned; work continues locally until provided.
4. **Meta route:** direct Tech Provider model; customers pay Meta directly; ConversaFlow subscription charges kept
   separate. Subject to confirmed eligibility and terms.
5. **Phase order:** plans, usage tracking and limits in Phase 1; live payments in Phase 5.

## ADR-022 — Separate authentication role (`cf_auth`)

Context: sign-up, sign-in, token checks and invitation look-ups must run before the user or company is known, which
RLS would (correctly) block. Decision: a few narrow `SECURITY DEFINER` functions owned by `cf_auth`, a non-login role
with RLS policies scoped `TO cf_auth`. `cf_app` may execute them but can never become `cf_auth` (tested).
Consequence: no general bypass; each function returns only what its step needs.

## ADR-023 — Switcher visibility only with no company selected

Found by the Milestone 1 isolation tests: a policy that let a user see "their own memberships in any company" also
applied while another company was selected, which allowed a session to switch into a company the user did not
belong to (later requests were still refused; no data was exposed). Decision: cross-company visibility of one's own
memberships and companies applies **only when no company is selected**. Regression test added.
