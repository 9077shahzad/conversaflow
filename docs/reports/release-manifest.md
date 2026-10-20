# Release manifest — Phase 1, candidates 1 and 2 (20 Oct 2026)

**Status:** development complete; local checks reported passed; GitHub CI, hosted verification and live pilot
approval pending.

Every claim below names the commit that was checked. Nothing has been pushed, deployed or connected.

## Candidate 2 (current)

| Role | Commit | What was done at exactly this commit | Evidence |
| --- | --- | --- | --- |
| **Reviewed (all candidate 2 changes)** | `e18d89fdf750f3c2fbd07e48d0310ab581f0799a` | Independent review of every security-relevant change since `3966c4c`. No Critical, High or Medium findings; three Low (L1–L3) and three informational | `M1-closure-report.md`, "Independent review of candidate 2" |
| **Rechecked (fixes)** | `56cdf5b52fd502c6843fd329d2d3e9aabd28dc14` | Recheck: L1, L2, I-a and the locale header verified. L3 mostly fixed; five more files named | Closure report; `clean-checkout-56cdf5b.txt` (all checks passed) |
| **Tested and packaged** | `aeb50787275f4d2758782d3018b804186c68ee66` | **Clean-checkout run:** fresh clone, frozen lockfile, fresh database, restricted roles; results below.<br>**Reviewer confirmation** that the change from `56cdf5b` is CODEOWNERS only, with full coverage | `clean-checkout-aeb5078.txt`; closure report |
| Packaged (documents) | The commit containing this file (hash in the handover message) | Documents and evidence only. Its code is identical to `aeb5078` | Command below |

```bash
git diff --stat aeb5078 HEAD -- apps packages scripts .github package.json pnpm-lock.yaml turbo.json pnpm-workspace.yaml
# expected: no output
```

### Results at `aeb5078` (clean checkout)

See `docs/reports/evidence/clean-checkout-aeb5078.txt`; the same results were seen at `56cdf5b` and `e18d89f`.

| Check | Result |
| --- | --- |
| Install | Frozen lockfile, installed exactly as locked |
| Secret scan, lint, type check, build | Passed |
| Dependency audit (strict, all packages) | **No advisories** in production or development and build tools; no exceptions in force |
| Audit-rule unit tests | 14/14 |
| Migrations | 0001–0015 on a fresh database |
| Isolation check (CI guard) | Passed |
| Database roles used by the tests | cf_app, cf_identity, cf_notify, cf_platform: none superuser, none bypasses row security |
| API tests | 230/230 in 16 files |
| Browser checks (English and Arabic, three sizes, security policy, not-found pages) | 10/10 |

### Differences

| From → to | Size | Security-relevant changes | Reviewed |
| --- | --- | --- | --- |
| `3966c4c` → `e18d89f` | 61 files, +1,094 / −750 | **Fixes:** enrolment race returns 409; migration 0014 (overrides can only be shortened).<br>**Not-found page:** rendered per request, with the middleware rewrite.<br>**Tailwind 3 → 4:** lockfile and CSS.<br>**Audit:** rules refactored, with owner and review-date checks.<br>**CI:** script tests added; the clean-checkout script uses the strict audit.<br>**CODEOWNERS:** added | Yes, at `e18d89f` |
| `e18d89f` → `56cdf5b` | 19 files, +228 / −101 | **L1:** `audit-rules.mjs`.<br>**L2:** migration 0015.<br>**L3:** wider CODEOWNERS.<br>**I-a:** exact `_next` match.<br>**Not-found page:** server component, with the `x-cf-locale` header | Yes, at `56cdf5b` |
| `56cdf5b` → `aeb5078` | 3 files | `.github/CODEOWNERS` only (plus documents) | Confirmed by the reviewer (diff only) |

## Candidate 1 (preserved)

| Role | Commit | Tag | State |
| --- | --- | --- | --- |
| Tested and rechecked | `3966c4c4b2a13070143a6f73fe621fdedcbfac3a` | `rc1-tested` | Clean checkout passed (228 API tests, 9 browser checks); F1–F3 verified closed |
| Packaged | `92e9c2e5b655edda295007a574a1a2d3a74ada0e` | `rc1-packaged` | Documents only on top of `rc1-tested`; zip and bundle archived |

The earlier reviewed commits `6972acb` (N1–N4) and `ee77e77` (F1–F3 found) are described in the closure report.

## Still open (not claimed)

- **GitHub:** CI on GitHub, and code-owner enforcement. Unlocked by the GitHub organisation and push approval.
- **Hosted verification:**
  - official malware signatures;
  - file-access revocation;
  - storage permissions;
  - session expiry;
  - backup restoration.

  These need a hosting decision.
- **Reviews and approvals still to come:** the external security review, Meta verification and App Review, and the
  pilot approval itself.
- **Remaining findings:** the complete numbered list is in the closure report. Items 1–3 concern the sign-in
  credential and recovery, with the M7–M9 decision pending.
