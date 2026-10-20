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

## ADR-024 — Residual risk: authentication functions callable by the app role

Context: the independent review showed that anyone able to run arbitrary SQL as `cf_app` could call
`auth_issue_token` for any user and then reset that user's password, or read password hashes through
`auth_credentials_by_email`. These functions exist because the API must email tokens and verify passwords.
Decision for Milestone 1: accept, because reaching this requires SQL injection (blocked by parameterised queries
everywhere and a lint rule that fails the build on interpolated SQL) or a compromised API process (which could
already act as any signed-in user). Planned fix (Phase 2): move token issuing and email sending into the worker
under a separate `cf_mailer` role, so the API role can no longer mint tokens; review again before the pilot.

## ADR-025 — Privileged database actions are bound to the session token, not to `app.user_id`

Context: the second independent review showed that any database role can set `app.user_id` for itself, so a
database function that trusted it (support-grant approval, feature flags, plan publishing) could be driven by anyone
holding that role's password, defeating the two-person rule. Decision: platform functions take the caller's session
token (never stored; compared by SHA-256) and derive the staff member from a live, MFA-verified session inside the
database. The platform role has no direct access to any company table. Sessions can only be opened through a
function that fixes their lifetime and starts them without MFA. The CI guard fails the build if a platform function
is callable without a token argument or if the platform role regains table access. `app.user_id` remains the
mechanism for ordinary row filtering under the business API role, which rechecks membership from the session on
every request.

## ADR-026 — Migrations 0002–0004 were edited before any shared database existed

The first independent review's fixes changed three migration files that had been applied only to disposable local
databases. The migration runner refuses changed files on any database that already applied them (checksum), so this
is safe for every environment that exists today (none are shared). From the first shared environment onward,
applied migrations are never edited; changes go in new files.

## ADR-027 — Two-step verification is decided inside the database; residual risk of the sign-in credential

Context: the independent post-fix recheck of commit 8d42a5b showed that the sign-in role (`cf_identity`) could open a
session for any user and mark it MFA-verified with a plain UPDATE, because row security trusted `app.user_id`, which a
role sets for itself. Combined with the platform credential this approved support grants; against a customer it
opened MFA-protected data.

Decision (migration 0010): no login role can write MFA data, read TOTP secrets or recovery codes, or mark a session
verified. `auth_mfa_begin`, `auth_mfa_confirm` and `auth_mfa_verify` (owned by `cf_auth`) identify the user from the
**session token**, check a real TOTP code (RFC 6238, computed in SQL) or recovery code, and are the only way to set
`mfa_verified_at`. TOTP secrets are sealed with a key in `auth_keys`, readable only by `cf_auth`. Wrong guesses are
limited in the database (10 per user per hour), on top of the API's limits. The CI guard fails the build on regression.

Residual risk (accepted for the pilot, review before general availability): password checking (Argon2id) runs in the
API, so whoever holds the `cf_identity` credential can still open a session **without** verified MFA for any user.
For users with MFA that session can only reach the MFA step. For users **without** MFA it is a full session.
Mitigations: (1) platform staff, Owners and Admins must use MFA (already enforced for sensitive permissions);
(2) at deployment, keep the identity credential in its own secret, readable only by the API service, never by the
worker or console; (3) option for the owner: require MFA for every pilot user (see readiness checklist).

## ADR-028 — Content Security Policy with a fresh nonce per page

Context: the web app allowed inline scripts and styles (`'unsafe-inline'`), so an HTML-injection flaw anywhere would
let injected script run with the user's session.

Decision: `apps/web/middleware.ts` creates 128 random bits per page request and sends
`script-src 'self' 'nonce-…' 'strict-dynamic'`, `style-src 'self' 'nonce-…'`, `style-src-attr 'none'`, `base-uri 'none'`,
`object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`. Next.js reads the policy from the request and
stamps the nonce on its own scripts. Pages therefore render per request (no static pre-rendering). The two inline
style attributes in the interface moved into CSS classes. Development mode adds `'unsafe-eval'` and `ws:` for hot
reload only.

Evidence: browser checks assert the header, that no `unsafe-inline`/`unsafe-eval` is present, that every script tag
carries the response's nonce, that two loads get different nonces, and that no page in either language at any of
the three screen sizes reports a violation. A further check injects an inline script and inline style into the real
HTML response and proves both are blocked and reported.

Limit: `'strict-dynamic'` trusts scripts created by already-trusted page code; it protects against injected markup,
not against a compromised dependency bundled into the app. Dependency auditing covers that separately.

## ADR-029 — Pilot enrolment: mandatory two-step sign-in and a separate seat allowance

Owner decisions (20 Oct 2026): every pilot user must use two-step sign-in; each pilot company gets a separate
10-seat allowance; the standard trial allowance stays unchanged; company selection and invitations remain pending.

Decision (migration 0011): a `pilot_enrolments` record, created and ended only by a platform owner through
token-bound console actions (`platform_enrol_pilot`, `platform_end_pilot`), both audited. Enrolment writes a
seat override that expires with the pilot (default 90 days, 7–180 allowed) and sets `requires_mfa`, which cannot be
false. While enrolled, every company request (guard) and every file download (link route) is refused with
`mfa_enrollment_required` unless the user has two-step sign-in and verified it in this session. Companies can read
their enrolment but no login role can write it or any limit override (CI guard).

This does **not** resolve ADR-027. See `docs/readiness/pilot-mfa-residual-risk.md` for the exposure that remains,
the mitigations and the risk acceptance still required.

## ADR-030 — Security notices for two-step sign-in

Mitigation M5 from the pilot residual-risk note (migration 0012). When two-step sign-in is turned on, or a recovery
code is used, the authentication function itself queues an email to the account's **stored** address. The notice
carries no token or sign-in link. The general email request function refuses these purposes, so a login role can
neither skip nor forge them. A test replays exposure E1 (a forged session enrolling an attacker's authenticator):
it still succeeds, which is the accepted residual, but the real owner is told.

Addendum to ADR-028 (targeted review of `ee77e77`, finding F3): the middleware now runs on every path. Pages get the
nonce policy; the API proxy, built assets and the favicon get a strict fallback (`default-src 'none'`). The API sets
its own policy, `nosniff` and `X-Frame-Options: DENY`, because Next.js drops middleware headers on proxied rewrites.
`htmlLimitedBots: /.*/` keeps `<title>` and other metadata in the document head under per-request rendering.
Known limit: a malformed prefetch request (prefetch header without the RSC header) makes Next.js itself return a
500; that response now carries the full policy and no attacker content.

## ADR-031 — Tailwind CSS 4 instead of an audit exception for braces

Context: GHSA-vfj7-8cjw-p6xm (CVE-2026-93687, High, availability only) affects `braces` through 3.0.3, the latest
release; no fix exists. Tailwind CSS 3.4 pulled it in through chokidar, fast-glob and micromatch (build time only).

Decision: migrate the web app to Tailwind CSS 4.3 with the official upgrade tool (candidate 2). Tailwind 4's
dependency tree contains no braces, chokidar or micromatch, so the advisory is removed rather than excepted and the
strict audit passes with no exceptions. Theme colours and fonts moved from `tailwind.config.ts` into `@theme` in
`globals.css`; a few utilities were renamed by the tool; autoprefixer is no longer needed.

Evidence: browser checks 10/10; all 24 reference screenshots compared pixel by pixel with Tailwind 3: sign-in and
dashboard identical, team identical apart from randomly generated demo email addresses, company settings rows
about 2 px shorter each (form-control base styles). Accessibility and readability checks unchanged.

Consequence: Tailwind 4 needs Safari 16.4+ (iOS 16.4, March 2023), Chrome 111+ or Firefox 128+. Older browsers show
the pages without styling. If pilot companies need older devices, revert this and approve a time-limited exception.
