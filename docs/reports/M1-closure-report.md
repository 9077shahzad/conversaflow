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
| F1 | Dependency audit passed when the audit itself could not run; proposed exceptions applied | Medium | Fails on error or empty result; only approved, in-scope exceptions pass in CI | **Verified closed** by the recheck of `3966c4c` |
| F2 | Clean-checkout script could report success after a failed install, lint or build | Medium | No `&&` lists; every step stops the run; proven with a deliberate lint error | **Verified closed** by the recheck of `3966c4c` |
| F3 | Some responses carried no security policy (API proxy, unanchored exclusions, prefetch) | Low | Middleware on every path with a strict fallback; API sends its own headers; tests per path | **Verified closed** by the recheck of `3966c4c` |
| I-1 | cf_ops broader than the pilot functions need | Informational | Migration 0013 narrows to the columns used | **Verified closed** by the recheck of `3966c4c` |
| I-2 | A company could not be enrolled again after its pilot ended | Informational | Migration 0013: one running pilot per company | **Verified closed** by the recheck of `3966c4c` |
| I-3 | The static not-found page has no nonce, so its scripts are blocked | Informational | Fails safe (the page still shows); no change | Accepted |
| I-4 | Pilot two-step rule enforced in the API, not in the database | Informational | By design (ADR-029); members without it see only their own membership | Accepted |

### Recheck of the fixes at 3966c4c (20 Oct 2026)

**Commit reviewed:** `3966c4c4b2a13070143a6f73fe621fdedcbfac3a` (fresh clone, frozen lockfile).
**Reviewer's result:** 228/228 API tests; browser checks 9/9 on two consecutive runs; failure injection at every step
of the clean-checkout script; probes of every path for the security policy; column-level grant inspection.
**Verdict:** F1, F2, F3 and migration 0013 fixed; no new issue above Informational.

Open informational items (no code change after `3966c4c`, so the tested, reviewed and packaged code stay identical):

| # | Item | Planned handling |
| --- | --- | --- |
| R4-1 | CI's strict audit fails until the braces exception is approved | Owner decision A13 |
| R4-2 | Anyone who can commit can mark an exception approved | Code-owner review on `docs/security/` when the GitHub organisation exists (A3) |
| R4-3 | Two enrolments at the same instant: the second gets a 500 instead of a 409 (nothing written) | Map error 23505 to 409 in the next code change |
| R4-4 | The operations role could extend an override's expiry (only the function's "expire now" path uses it; role cannot log in) | Tighten the policy to expiry no later than now, in the next migration |
| R4-5 | The static not-found page's scripts are blocked (fails safe) | Make the not-found page render per request, in the next web change |


## Candidate 2 — follow-ups closed, and the complete list of remaining findings (20 Oct 2026)

Candidate 1 (tested `rc1-tested` = `3966c4c`, packaged `rc1-packaged` = `92e9c2e`) is preserved as git tags and
archived. Candidate 2 fixes:

| Item | Fix in candidate 2 | Status |
| --- | --- | --- |
| R4-1 CI audit red on braces | Tailwind CSS 4 removed braces entirely (ADR-031); no exception needed; strict audit passes | **Verified** by the review of `e18d89f` |
| R4-2 exception approval is a plain repo edit | `.github/CODEOWNERS` prepared for `docs/security/`, CI, migrations and security scripts; exception rules now require owner and review date (14 unit tests) | Prepared — **enforcement pending GitHub configuration** |
| R4-3 enrolment race returned 500 | Unique-rule conflicts return 409; test with three simultaneous requests | **Verified** by the review of `e18d89f` |
| R4-4 override expiry could be extended | Migration 0014: the operations role can only set an expiry no later than now | **Verified** by the review of `e18d89f` |
| R4-5 static not-found page blocked by the policy | Localised not-found page rendered per request with the nonce; unknown paths routed to it with status 404; tests | **Verified** by the review of `e18d89f` |

### Remaining findings — complete numbered list

| # | Finding | Source | Severity | Status | What closes it |
| --- | --- | --- | --- | --- | --- |
| 1 | The sign-in database credential can open a session for a user without two-step sign-in and enrol its own authenticator (account takeover before the user's own set-up) | ADR-027, second recheck | Accepted residual (pending owner acceptance) | Detection in place (M5); prevention options M7, M9 not built | Owner decision on M7–M9, then signed acceptance; M6 before general availability |
| 2 | The same credential can lock a user out of two-step sign-in for one hour | R2-1 | Low | Open, within item 1 | M1–M3 (protect the credential); M6 |
| 3 | No procedure to reset two-step sign-in when a user loses the authenticator and all recovery codes | Found while preparing the risk note, 20 Oct | Low (availability; unsafe manual workaround) | Open | M8: two-person, audited reset in the console |
| 4 | Pilot two-step rule is enforced in the API, not in the database | Targeted review I-4 | Informational | Accepted by design (ADR-029) | — |
| 5 | Code-owner review of security files not enforced until GitHub is configured | R4-2 | Informational | Prepared | Owner: GitHub steps (A3) |
| 6a | Not-found responses are sent as Next.js's error shell; the localised page appears once scripts run (status 404 and nonces correct) | Review of `e18d89f` | Informational | Accepted (framework behaviour in Next.js 15) | Revisit with a Next.js upgrade |
| 6b | Next.js's own trailing-slash and double-slash redirects (308, no body, same origin) carry no security policy | Review of `e18d89f` | Informational | Accepted (sent before middleware) | — |
| 6 | The CI guard would not notice a new definer function granted to a login role that writes pilot or override tables | Targeted review, item 4 | Informational | Open | Extend the guard to list functions each login role can run |
| 7 | A malformed prefetch request (prefetch header without RSC) makes Next.js return a 500; the response carries the full policy | Targeted review F3 notes | Informational | Accepted (framework behaviour) | — |
| 8 | `base32_decode` unused on the verification path | R2-2 | Informational | No action | — |
| 9 | Authenticators set up before migration 0010 cannot pass TOTP (local databases only) | R2-3 | Informational | No action | — |
| 10 | Hosted verification not yet possible: official signatures, file revocation, storage permissions, session expiry, backup restore | Owner conditions | — | Pending hosting approval | Owner: hosting decision (A4) |
| 11 | `packages/database/src/client.ts` (company context for row security) is not yet under code-owner review | Check of `58d156f` | Informational | Open | Add to CODEOWNERS in the next candidate |

### Independent review of candidate 2 at `e18d89f` (20 Oct 2026)

**Commit reviewed:** `e18d89fdf750f3c2fbd07e48d0310ab581f0799a` (fresh clone, frozen lockfile).
**Reviewer's result:** 230/230 API tests (the pilot suite three more times); browser checks 10/10 on two runs;
`test:scripts` 14/14; strict audit with no advisories; seed script under the operations role.
**Verdict:** R4-1, R4-3, R4-4 and R4-5 verified; the Tailwind 4 lockfile has registry sources only with integrity
hashes; no open redirect or route confusion through the new rewrite. No Critical, High or Medium findings.

| # | Finding | Severity | Fix (final candidate 2 commit) | Status |
| --- | --- | --- | --- | --- |
| L1 | The audit script could exit 0 without running when started through a symlinked absolute path | Low | Decision rules moved to `scripts/audit-rules.mjs`; the audit script always runs (no main-module check). Tested through a symlink with the registry unreachable: exit 1 | **Verified** by the recheck of `56cdf5b` |
| L2 | The operations role could insert a new, long-lived seat override | Low | Migration 0015: inserted overrides must expire within 181 days; test added | **Verified** by the recheck of `56cdf5b` |
| L3 | CODEOWNERS missed files that decide what CI runs | Low | Added root `package.json`, lockfile, `turbo.json`, audit rules and tests, secret scan, local-services script, database `package.json`, guard, API app, middleware, CSP and Next config. The recheck of `56cdf5b` found five more (`pnpm-workspace.yaml`, both app `package.json` files, `migrate.ts`, `playwright.config.ts`); added in the final commit with the test folders and ClamAV set-up | Prepared — enforcement pending GitHub |
| I-a | `/_nextfoo` skipped the not-found rewrite (prefix match) | Informational | Exact match on `_next`; test added | **Verified** by the recheck of `56cdf5b` |
| I-b | Not-found responses are Next.js's error shell until scripts run | Informational | Not-found page is now a server component; the shell is framework behaviour | Accepted (item 6a) |
| I-c | Next.js's own 308 redirects carry no policy | Informational | — | Accepted (item 6b) |

Recheck of `56cdf5b52fd502c6843fd329d2d3e9aabd28dc14`: L1, L2, I-a and the not-found locale header verified (230/230 API
tests, browser checks 10/10 twice, `test:scripts` 14/14, strict audit with no advisories, own probes of the
181-day bound and the locale header). L3 coverage completed afterwards as listed above; the change is to
`.github/CODEOWNERS` only (not enforced until GitHub is configured).

Final check of `aeb50787275f4d2758782d3018b804186c68ee66` (reviewer, read-only): the change from `56cdf5b` is
CODEOWNERS only; the eight added paths are covered; `apps/api/vitest.config.ts` was still missing (Low). Closed
with pattern rules covering every `package.json`, `*.config.*` and `tsconfig*.json` file and the gitleaks
configuration (including files created later), so coverage no longer depends on listing each file.

Check of `58d156f48b4bcd502cc86b5b05de1253eb5d1d42` (reviewer, read-only, every tracked file run through
gitignore-style matching): the change from `aeb5078` is CODEOWNERS only; **nothing that decides what CI runs is
left uncovered**, including files added later. L3: **verified** (enforcement still pending GitHub configuration).
Optional for the next candidate: add `packages/database/src/client.ts` (sets the company context row security
relies on) to the security-code owners, alongside the guard and middleware (remaining findings list, item 11).

## Candidate 3 — M7, M8, M9 and the two remaining review gaps (20 Oct 2026)

Candidate 2 is preserved (`rc2-tested` = `58d156f`, `rc2-packaged` = `bec9ee8`, archived).

| Item | Change | Evidence | Status |
| --- | --- | --- | --- |
| M7 | Authenticator activates only after an 8-digit code emailed to the verified address is entered in the session that started set-up (migration 0016, ADR-032) | `m7-m9.test.ts`: flow; session binding, single use, 15-minute expiry; guessing limit; E1 replay blocked; the sign-in role cannot read, create or redirect codes or change the address; a leaked code is useless in a forged session | Built — **verified** by the review of `c6c51b8` |
| M8 | Two-person, identity-checked, audited reset; every session ends; user notified (migration 0017, ADR-033, runbook) | Tests: support agent refused; document numbers refused; requester cannot approve; second owner approves; factors gone, sessions ended, notice, audit, re-enrolment with M7; one open request; rejection; expiry; no reset of own account; no login role can run the reset | Built — **verified** by the review of `c6c51b8` (two Low items fixed since). **Usable only with a second platform owner** |
| M9 | Pilot invitations 72 hours; list and revoke; single use (ADR-034) | Tests: 72 h vs 7 days; revoked link refused at once; list never shows tokens; second use and expired link refused | Built — **verified** by the review of `c6c51b8` |
| Item 6 | CI guard flags privileged functions that could write pilot or override records (ADR-035) | Test with planted functions (direct and dynamic SQL) | Built — **verified** by the review of `c6c51b8` |
| Item 11 | `packages/database/src/client.ts` under code-owner coverage | CODEOWNERS | Prepared — enforcement pending GitHub |
| Browsers | Unsupported-browser notice in both languages; Firefox and WebKit configured for CI | Browser check: notice hidden in Chromium; built CSS rule inspected | Built; Firefox/WebKit first run pending GitHub; real-device check pending staging |

### Remaining findings — complete numbered list (candidate 3)

| # | Finding | Severity | Status | What closes it |
| --- | --- | --- | --- | --- |
| 1 | Takeover before the user finishes set-up now needs the sign-in credential, database network access **and** the user's mailbox or cooperation (was: credential alone) | Accepted residual (pending owner acceptance) | Reduced by M7 and M9 | Signed acceptance; M6 before general availability |
| 2 | The sign-in credential can lock a user out of two-step sign-in for one hour | Low | Open | M1–M3; M6 |
| 3 | Recovery after losing authenticator and all codes | — | **Closed by M8**, but the process needs a second platform owner to be usable | Owner: name a second platform owner |
| 4 | Pilot two-step rule enforced in the API, not the database | Informational | Accepted (ADR-029) | — |
| 5 | Code-owner review not enforced until GitHub is configured | Informational | Prepared | Owner: GitHub set-up |
| 6 | CI guard blind to privileged functions writing pilot/override records | — | **Closed** (ADR-035) | — |
| 7 | Framework-level items: Next.js's own redirects and error shell; malformed prefetch 500 | Informational | Accepted | Revisit with Next.js upgrades |
| 8 | `base32_decode` unused; pre-0010 factors cannot pass TOTP (local only) | Informational | No action | — |
| 9 | Hosted verification (signatures, revocation, storage, session expiry, backup restore) | — | Pending | Owner: hosting decision |
| 10 | Firefox/WebKit browser checks not yet run; real-device check pending | — | Configured | GitHub set-up (CI), then staging |
| 11 | Database-context code outside code-owner coverage | — | **Closed** (enforcement pending GitHub) | — |

### Independent review of candidate 3 at `c6c51b8` (20 Oct 2026)

**Commit reviewed:** `c6c51b88dbaabaa860291108751528952a18eca5` (fresh clone, frozen lockfile).
**Reviewer's result:** 243/243 API tests; browser checks 11/11 twice (Chromium only; Firefox and WebKit verified by
reading the configuration); `test:scripts` 14/14; strict audit with no advisories; own probes as the sign-in role,
a three-way activation race (one success, exactly 10 recovery codes), and cross-company invitation revocation.
**Verdict:** "M7's core property holds: someone with the sign-in database credentials can neither change where the
confirmation code goes nor activate an authenticator without the emailed code." No Critical, High or Medium.

| # | Finding | Severity | Fix (migration 0018 and API) | Status |
| --- | --- | --- | --- | --- |
| L-A | Identity-reference filter bypassed with spaced, dashed, Arabic-Indic or full-width digits | Low | First fix (runs with separators) still bypassable (recheck of `42823bb`); final rule: at most 5 digits in total, any script (migration 0019) | **Verified** by the recheck of `4e60aeb` |
| L-B | Second approver could not see the request before approving | Low | `GET /v1/platform/mfa-resets` (platform owners): reason, method, reference, requester | **Verified** by the recheck of `42823bb` |
| L-C | Invitations sent before enrolment kept 7 days; 72-hour rule only in application code | Low | Enrolment cuts pending invitations to 72 h; database trigger caps pilot invitations (verified at `42823bb`); cap counted from creation (0019), and the creation time can no longer be set or the row deleted by the business role (0020, 0021) | **Verified** by the rechecks of `6f78a89` and `f1bc095` |
| L-D | CI guard missed a writer reached through a helper, and `concat()` dynamic SQL | Low | Dedicated owner role `cf_pilot`; owner-based guard (verified for those two at `42823bb`). The recheck found three more gaps (another schema, a privileged trigger, a rule); the guard now covers all schemas, triggers on any table (G2), rules and views (ADR-037), and pins reviewed trigger functions to their whole definition and owner (G3) | **Verified** by the rechecks of `4e60aeb`, `6f78a89` and `f1bc095` |
| I | The notifier credential chooses and sends the code (inherent to sending mail) | Informational | Activation still needs the enrolling session | Accepted |
| I | No cap on confirmation emails | Informational | Capped at 5 per user per hour | **Verified** by the recheck of `42823bb` |
| I | Password unchanged after a reset | Informational | Runbook advises a password change | Documented |
| I | Not-found pages do not show the browser notice | Informational | Cosmetic | Accepted |

### Targeted rechecks after `c6c51b8` (20 Oct 2026)

| Recheck at | Verified | Still open after that recheck |
| --- | --- | --- |
| `42823bb` | L-B; email cap; L-C enrolment cut and trigger; L-D helper and `concat()` cases | L-A (separated digits); L-C (cap could be renewed); L-D (other schema, privileged trigger, rule) |
| `4e60aeb` | L-A (at most 5 digits in total, any script); L-D cases C–H | L-C: business role could set `created_at`. G2: privileged trigger on a table only privileged functions write |
| `6f78a89` | **L-C** (creation time cannot be set; cap counted from the stored creation time); **G2** for its own case (`mfa_attempts`); a replaced reviewed body is flagged; the four reviewed trigger functions write nothing | G3 (Low): the pin covered only the body, so a migration could change a reviewed function's `search_path`, owner or security mode unnoticed. Informational: business role still had DELETE on invitations |
| `f1bc095` | **G3** (search_path, owner and other setting changes all flagged; an invoker switch correctly ignored); **invitation DELETE** refused (42501), invite/accept/revoke unaffected | G4 (documented residual risk, see below) |

**Fix for G3 and the informational item (migration 0021 and the guard):** reviewed trigger functions are pinned to
the md5 of their whole definition (`pg_get_functiondef`: body, `search_path` and other settings, security mode,
language) plus owner; the business role loses DELETE on invitations, which it never used.

**G4 — documented residual risk (Low); owner acceptance pending.** At `f1bc095` the reviewer showed that a migration could replace a table that one of
the four reviewed trigger functions reads (for example `trial_policy`) with a view calling a writing function; the
reviewed function's definition is unchanged, so the guard passes. Further guard extensions are not pursued:
migrations run as the table owner, so a hostile migration could write a seat override directly, and no database
check can prevent that. The guard's job is to catch accidental privilege drift; the control against a hostile or
careless migration is code-owner review of `packages/database/migrations/`, which is **pending** until enforced
and verified on GitHub. Record and acceptance wording: `docs/readiness/database-change-residual-risk.md`.
If wanted later, the four functions can be schema-qualified and the guard can refuse views that call non-catalog
functions.

### Remaining findings — complete numbered list (candidate 3 final, `rc3-tested` = `f1bc095`)

| # | Finding | Severity | Status | What closes it |
| --- | --- | --- | --- | --- |
| 1 | Takeover before the user finishes set-up needs the sign-in credential, database network access **and** the user's mailbox or cooperation | Documented residual risk; **owner acceptance pending** | Reduced by M7 and M9 | Signed acceptance; M6 before general availability |
| 2 | The sign-in credential can lock a user out of two-step sign-in for one hour | Low | Open | M1–M3; M6 |
| 3 | Reset process needs a second platform owner to be usable | — | Built (M8) | Owner: name a second platform owner |
| 4 | Pilot two-step rule enforced in the API, not the database | Informational | Accepted (ADR-029) | — |
| 5 | Code-owner review not enforced until GitHub is configured | Informational | Prepared, **enforcement pending** | Owner: GitHub set-up, then verification |
| 6 | Framework-level items: Next.js's own redirects and error shell; malformed prefetch 500 | Informational | Accepted | Revisit with Next.js upgrades |
| 7 | `base32_decode` unused; pre-0010 factors cannot pass TOTP (local only) | Informational | No action | — |
| 8 | Hosted verification (signatures, revocation, storage, session expiry, backup restore) | — | Pending | Owner: hosting decision |
| 9 | Firefox/WebKit browser checks not yet run; real-device check pending | — | Configured | GitHub CI, then staging |
| 10 | G4: a hostile migration could swap a table read by a reviewed trigger function | Low | Documented residual risk; **owner acceptance pending** | Code-owner review of migrations (item 5, pending); signed acceptance |
| 11 | The notifier credential chooses and sends the code; password unchanged after a reset; not-found pages lack the browser notice | Informational | Accepted / documented | — |

L-A, L-B, L-C, L-D, G2, G3, the email cap and the invitation-delete item are all **verified closed**.
