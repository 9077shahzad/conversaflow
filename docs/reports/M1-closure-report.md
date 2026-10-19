# Milestone 1 closure report — finding by finding

Commit: see `docs/reports/evidence/M1-handover-run.txt` (first line). Status: **locally checked**; GitHub CI and
hosted verification **pending** (no repository or environment provided yet).

Status meaning: **Closed** = fixed, with a regression test that asserts the attempt is refused and the protected data
is unchanged. **Accepted** = documented residual risk with an ADR. **Pending** = needs something outside the code.

## Owner's pre-pilot conditions (19 Oct 2026)

| Condition | Status | What was done | Test |
| --- | --- | --- | --- |
| Resolve credential-change permissions | Closed | Four database roles: `cf_app` (business data) has no rights over credentials, sessions or tokens; `cf_identity` (sign-in) opens sessions only via a capped function; `cf_notify` (worker) is the only role that can mint email tokens, with lifetimes capped in the database; CI guard fails the build on regression | credentials.test (6), review2.test |
| Implement session expiry | Closed | 60-minute idle and 12-hour absolute limits; the 12-hour cap is enforced inside the database; enabling MFA ends other sessions | credentials.test (5), review2.test |
| Replace the test-only virus scanner | Closed | ClamAV daemon over the INSTREAM protocol; fail-closed (503, nothing stored) on any error or timeout; the test scanner is refused in production. Local and CI runs use the real engine with a test signature; hosted runs need official auto-updated signatures | scanner.test (6) |
| Verify file-access revocation in the hosted environment | Pending (hosted) / Closed (local) | `file-revocation-check` script for a deployed environment, proven locally in a dry run and shown to catch a deliberately broken server | hosted-check.test (2) |
| Regression tests assert refusal and unchanged data | Closed | Every security test checks both the refusal and a before/after fingerprint of the protected rows | credentials.test, review2.test, isolation.* |

## First independent review (before this handover)

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | Roles or invitations could carry permissions the actor lacked, including to themselves | High | Closed — rbac.test (4) |
| 2 | MFA guessing allowance reset by signing in again | Medium | Closed — per-user limit, single-use codes; auth.test (2) |
| 3 | Download link kept working after losing `files.read` | Low | Closed — isolation.api.test |
| 4 | API role could mint reset tokens / read password hashes with direct SQL access | Hardening | Closed in this handover (credential separation); credentials.test |
| 5 | API role could rewrite user email or verification time | Hardening | Closed — column grants; isolation.db.test |
| 6 | Price freeze missed new rows; override names unchecked | Hardening | Closed — limits.test |
| 7 | Rate-limit expiry race; bad page size 500; unused grant; non-public plans | Hardening | Closed |
| 8 | Weak test assertions | Test quality | Closed |

## Second independent review (this handover)

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | Anyone holding the platform database password could approve their own support access by setting `app.user_id` to an owner's id, then read company files | High | Closed — every platform action now takes the caller's session token and the database derives the staff member from a live, MFA-verified session; the platform role has no direct table access; CI guard checks both. review2.test replays the exact attack (refused, grant unapproved, files unread) |
| 2 | Identity role could insert a session with MFA pre-verified and a 10-year lifetime, taking over any account | Medium | Closed — sessions can only be opened through `auth_open_session` (1–12 h, MFA not verified); the lookup also refuses sessions older than 12 h; review2.test |
| 3 | Business API role could activate its own trial, change plan and seats | Medium | Closed — no UPDATE/DELETE on subscriptions; any subscription the API inserts is forced to a trial by a trigger; review2.test |
| 4 | NULL idle timeout skipped idle expiry | Low | Closed — review2.test |
| 5 | API/identity role could point a session at another company (denial of service only; membership is rechecked) | Low | Accepted — ADR-025; no data exposure; switch endpoint rechecks membership (isolation.api.test) |
| 6 | Notifier could mint tokens of any lifetime | Low | Closed — lifetimes capped per purpose in the database; review2.test |
| 7 | Platform role could forge entries in a company's audit trail | Low | Closed — direct access removed; only `support.viewed` is written, by the function; review2.test |
| 8 | Directory callable without a staff identity; support agents could read the whole platform audit log | Low | Closed — token required; direct read removed; review2.test |
| 9 | Metering race: failed/completed at the same moment; check-then-act on the limit | Low | Closed — per-run and per-company locks; `startRun` reserves atomically; review2.test (2) |
| 10 | Already-applied migrations were edited | Low | Accepted — ADR-026 (no shared database existed); from the first shared environment, never again |
| 11 | Reset email sent to the typed address rather than the stored one | Low | Closed — review2.test |
| 12 | Upload size limit hard-coded; scanner ping unused; no CSP; missing verify/reset pages | Hardening | Closed — limit from config; API refuses to start if clamd is unreachable; CSP added (scripts still allow inline for Next.js bootstrap, nonces on backlog); pages added and checked in both languages |

## Still open before a live pilot

- GitHub organisation and repository → first CI run (all steps are written, including browser checks and screenshot upload).
- Hosting approval → staging → `file-revocation-check` run against it; backup restore drill; off-site logs.
- Independent human security review and penetration test (proposal in the preparation pack).
- Hosted ClamAV with official signatures (`freshclam`), and `AlertExceedsMax yes` in its configuration.
- Per-request CSP nonces in the web app.
