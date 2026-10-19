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
| 2 | Identity role could insert a session with MFA pre-verified and a 10-year lifetime, taking over any account | Medium | Reopened by the post-fix recheck (N1), fixed again in migration 0010 — MFA is now decided only inside the database; see the recheck section; review2.test, review3.test |
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

## Independent post-fix recheck of commit 8d42a5b (19 Oct 2026)

A fresh reviewer re-tested every finding above against the exact commit (204/204 tests passing at the time).

- **Verified closed by the reviewer:** owner conditions (credential permissions for the business role, session expiry on
  the API path, real virus scanner), first review #1–#8, second review #1 (for the platform credential on its own), #3,
  #4, #6, #7, #8, #11, and the new signature-freshness check.
- **Accepted, reviewer agrees:** second review #5 and #10.
- **Cannot verify locally:** the hosted file-revocation check (needs a deployed environment).
- **Not closed — second review #2 (variant N1, Medium):** the sign-in role could still open a session for any user and
  mark it MFA-verified, which reached platform-owner actions and MFA-protected customer data.
- **New, Low:** N2 staff sessions ignored user status and idle limit; N3 a recovery code could be spent twice in a race;
  N4 signature-date edge cases (future dates, version 0, clamd local time).

| Recheck finding | Fix | Regression test | Status |
| --- | --- | --- | --- |
| N1 MFA-verified session forgeable by the sign-in role | Migration 0010: MFA decided only in the database from the session token; sealed secrets; DB guessing limit; CI guard | review3.test (5) | **Verified closed** by the second recheck of `6972acb` |
| N2 staff session ignored status / idle | `platform_session_staff` requires an active user, 60-minute idle, 12-hour absolute | review3.test (2) | **Verified closed** by the second recheck of `6972acb` |
| N3 recovery-code race | Single-use enforced in the database function | review3.test (1) | **Verified closed** by the second recheck of `6972acb` |
| N4 signature-date edge cases | Future dates, version 0 and zone suffixes read as unreadable (blocks uploads); clamd runs with TZ=UTC | scanner.test | **Verified closed** by the second recheck of `6972acb`; hosted check with official signatures still open |
| Residual: sign-in credential can open a non-MFA session for any user | Accepted with mitigations (ADR-027) | review3.test documents the boundary | Reviewer agrees it is accurately scoped — **owner to confirm** |

## Second independent recheck of commit 6972acb (19 Oct 2026)

**Commit reviewed:** `6972acb61309cb4586a0af17a2a163745328f5ea`, from a clean clone, fresh database, restricted roles.
**Reviewer's result:** 213/213 tests, isolation guard passed, plus 7 of the reviewer's own probes, all passing.
**Verdict:** "N1–N4 are genuinely closed and the ADR-027 residual is accurately scoped and reasonable; no new High/Medium
issues. The fixes hold for this exact commit."

| Item | Reviewer's verdict | What the reviewer checked |
| --- | --- | --- |
| N1 | Verified closed | Sign-in role cannot update the verified flag, assume other roles, read the key or call the internal TOTP functions; full attack replayed and refused |
| TOTP window, replay, guessing limit | Verified closed | ±1 step only; a code works once across sessions; 10 failures per hour enforced under concurrency; interoperates with authenticator apps |
| N2 | Verified closed | Disabled user, 61 minutes idle and 13 hours old all refused |
| N3 | Verified closed | Two simultaneous uses of one recovery code: exactly one succeeds |
| N4 | Verified closed | Future, 2099, version 0, partial and zone-suffixed replies all block uploads |
| Residual (ADR-027) | Agrees, accurately described | A forged session for an MFA user reaches only the challenge and sign-out; for a non-MFA user it equals knowing the password |
| Cross-company, credentials, billing, console | Verified closed | Guard and isolation suites green; the console role alone reads nothing |

New observations, none above Low:

| # | Observation | Severity | Status |
| --- | --- | --- | --- |
| R2-1 | Someone holding the sign-in database credential could lock a user out of MFA for an hour by forcing 10 wrong guesses | Low (inside the ADR-027 residual; denial of service only) | Open — owner to accept with the residual. Mitigation is protecting that credential (secrets manager, network-restricted database) |
| R2-2 | `base32_decode` is not used on the verification path | Informational | No action |
| R2-3 | Authenticator set up before migration 0010 can no longer pass TOTP (recovery codes still work) | Informational | No action: affects disposable local databases only; documented in the migration |

The harness note from the reviewer: in its sandbox the disposable database folder had to sit outside the scratch
directory because of folder permissions. Application code, migrations and roles were unchanged.


## Targeted independent review of the security changes after 6972acb (20 Oct 2026)

**Commit reviewed:** `ee77e774c5e4f7376cdccc5abc67b150bcc74f66` (clean clone, frozen lockfile).
**Reviewer's result:** 226/226 API tests; browser checks 9/9 on re-run (one first-run failure, `document-title`, traced
to streamed metadata and fixed); own probes against every login role.

| Scope | Reviewer's verdict at `ee77e77` |
| --- | --- |
| Content Security Policy with per-request nonce | Verified; one Low gap (F3) |
| Pilot enrolment (mandatory two-step sign-in, seat allowance) | Verified; informational notes on cf_ops breadth and re-enrolment |
| Security notices (migration 0012) | Verified; N1–N4 logic unchanged |
| CI guard rule | Verified (limit: would not see a new definer function granted to a login role) |
| Dependency changes and audit script | Issue F1 (Medium) |
| Clean-checkout script and CI | Issue F2 (Medium) in the script; CI verified |

| # | Finding | Severity | Fix (commit `3966c4c`) | Status |
| --- | --- | --- | --- | --- |
| F1 | Dependency audit passed when the audit itself could not run; proposed exceptions applied | Medium | Fails on error or empty result; only approved, in-scope exceptions pass in CI | Fixed — **awaiting independent recheck** |
| F2 | Clean-checkout script could report success after a failed install, lint or build | Medium | No `&&` lists; every step stops the run; proven with a deliberate lint error | Fixed — **awaiting independent recheck** |
| F3 | Some responses carried no security policy (API proxy, unanchored exclusions, prefetch) | Low | Middleware on every path with a strict fallback; API sends its own headers; tests per path | Fixed — **awaiting independent recheck** |
| I-1 | cf_ops broader than the pilot functions need | Informational | Migration 0013 narrows to the columns used | Fixed — awaiting recheck |
| I-2 | A company could not be enrolled again after its pilot ended | Informational | Migration 0013: one running pilot per company | Fixed — awaiting recheck |
| I-3 | The static not-found page has no nonce, so its scripts are blocked | Informational | Fails safe (the page still shows); no change | Accepted |
| I-4 | Pilot two-step rule enforced in the API, not in the database | Informational | By design (ADR-029); members without it see only their own membership | Accepted |
