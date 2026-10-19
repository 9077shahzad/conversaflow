# Milestone 1 report — foundation, isolation, authentication, roles

Date: 19 Oct 2026 · Environment: local, disposable PostgreSQL 16 + Redis 7 · No live services used.

## Result

**122 of 122 automated tests pass** on a freshly created database, plus the database isolation check, lint, type-check,
dependency audit (no known high or critical issues) and secret scan. Evidence: `docs/reports/evidence/`.
The GitHub Actions pipeline is written but **has not run on GitHub yet** (no repository provided), so CI itself is unverified.

## What was developed

| Area | Done in Milestone 1 |
| --- | --- |
| Repository | pnpm + Turborepo monorepo; `apps/api` (NestJS 11), `apps/worker` (scaffold), `apps/web` (placeholder), `packages/database`, `packages/contracts` |
| Automated checks | ESLint (incl. a rule that blocks values interpolated into SQL), TypeScript strict, build, `pnpm audit`, gitleaks + local secret scan, migrations, isolation check, tests — all in `.github/workflows/ci.yml` |
| Database | 5 migrations, 21 tables, 3 roles, 18 functions, forced row-level security on every company table, composite foreign keys, append-only hash-chained audit log, frozen price versions |
| Authentication | Sign-up with email verification, sign-in, Argon2id, server sessions in httpOnly cookies, TOTP two-step verification with recovery codes, session list/revoke, password reset that ends all sessions, rate limits, anti-forgery check, no account enumeration |
| Companies and roles | Company creation with trial plan, five system roles, custom roles (no privilege escalation), invitations, role changes, removal, last-Owner protection, MFA required for sensitive permissions |
| Plans and limits | BRD v1.1 proposed prices and limits as data; seat limit enforced under concurrency; metered usage with 80%/95% warnings and hard stop; per-company overrides |
| Files | Company-scoped storage keys enforced by the database; type allow-list; malware-scan hook; 5-minute download links bound to user and company |

## Database objects

Tables: users, user_credentials, mfa_factors, mfa_recovery_codes, sessions, auth_tokens, tenants, memberships,
permissions, roles, role_permissions, membership_roles, invitations, plans, plan_versions, plan_entitlements,
subscriptions, entitlement_overrides, usage_counters, audit_events, files (21), plus schema_migrations.
Roles: cf_owner (migrations), cf_app (API/worker), cf_auth (non-login owner of 8 authentication functions).

## Tests

| Suite | Tests | What it proves |
| --- | --- | --- |
| isolation.db | 13 | In every company table (read from the catalogue), company A sees none of B's rows, cannot change, delete, insert or move rows into them, cannot link to them; app cannot rewrite emails or session owners; empty with no company; no context leak between pooled connections; app role cannot escalate |
| isolation.api | 17 | B cannot read, change or remove A's members, switch into A, see A in any list, or open A's files by id, link, forged link, expired link or cross-company link; storage paths stay in the company folder; removed members lose access at once; demoted members' download links stop working |
| auth | 17 | Sign-up, verification, sign-in, MFA, recovery codes, per-user MFA limit, no code reuse, rate limits, anti-forgery, cookie flags, hashed secrets, sessions, password reset |
| rbac | 61 | 5 roles x 10 endpoints matrix, plus MFA rule, no-company rule, Admin limits, last Owner, no self-promotion, no granting or inviting beyond own permissions, custom roles, live role changes |
| limits | 8 | 20 simultaneous acceptances on 3 seats → exactly 2; usage warnings and hard stop; 30 parallel uses never overshoot; catalogue; frozen prices (no edits, no new limits); override names checked |
| audit | 6 | Order and actor recorded; append-only even for the owner role; tampering detected; private per company |

## Defects the tests found and fixed during the milestone

1. **Company switch flaw (security).** A database rule let users see their own memberships in other companies even
   while working inside one. A user of company B could set their session to company A's id; every later request was
   refused and no A data was returned, but the switch should never have been accepted. Fixed in the database rules
   (ADR-023) and the switch check; regression test added.
2. Price-freeze trigger referenced a column missing on one table; split into two triggers.
3. Dependency audit found high-severity advisories in the upload library (via NestJS 10) and the email library;
   upgraded to NestJS 11 and nodemailer 10.

## Independent review (separate reviewer, read-only, with exploit probes)

No way was found for one company to reach another company's records or files. Findings inside a company, and their status:

| Finding | Severity | Status |
| --- | --- | --- |
| A member manager or Admin could give roles (or invite people into roles) carrying permissions they lack, including to themselves | High | Fixed: grants and invitations must stay within the actor's own permissions; nobody edits their own roles; 4 regression tests; reviewer's probe now refused (403) |
| MFA guessing allowance reset by signing in again | Medium | Fixed: limit per user (10 per hour) as well as per session; codes can no longer be reused within their window; 2 tests; probe now capped at 10 guesses |
| Download link kept working after the holder lost `files.read` | Low | Fixed: permission re-checked at download; test added; probe now 403 |
| App role could rewrite a user's email or verification time | Hardening | Fixed: column-level grants; test added |
| Price-freeze did not cover new limit rows; override names unchecked | Hardening | Fixed; tests added |
| Rate-limit counter could lose its expiry; bad page size gave 500; unused update right on role links; non-public plans selectable | Hardening | Fixed |
| Weak test assertions (accepted a generic error; one vacuous audit check; no "move row to other company" test) | Test quality | Fixed |
| With direct database access as the app role (e.g. through SQL injection), an attacker could mint a password-reset token or read password hashes via the authentication functions | Hardening | **Open — accepted for Milestone 1** (ADR-024): SQL injection is blocked by parameterised queries and a lint rule; planned fix in Phase 2 moves token issuing and email sending to a separate worker role |

## Security notes and known limitations

- Database isolation protects against query mistakes, not against compromised API code: the API sets the company
  context. Mitigation: the company comes only from the session after a membership check; code review; pen test.
- The malware scanner only recognises the standard EICAR test file. ClamAV (or a managed scanner) is required before
  any real customer uploads (Phase 2).
- File storage uses a local-disk driver; the S3-compatible driver follows once hosting is approved.
- Sessions last 7 days with no idle timeout yet; idle expiry for privileged roles is planned.
- Local test clusters use trust authentication on loopback only; CI and production use passwords.
- Rate limiting by IP depends on correct proxy configuration once hosted.

## Remaining Phase 1 work

M1.4 company settings (business hours, holidays, SLA targets), teams and branches · M1.5 plan change flow ·
M1.6 platform owner console and break-glass support access · M1.7 web app with English/Arabic RTL ·
M1.8 observability, threat model, Terraform plan (not applied), readiness report.

## Needs your action or approval

- Meronatic-owned GitHub organisation and repository (see `docs/github-setup.md`), then approval for me to push.
- Exact legal name of the Dubai entity, from the incorporation documents.
- Remaining decisions are consolidated in the plan document.
