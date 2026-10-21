# Release manifest — Phase 1 candidates 1 to 3 (20 Oct 2026) and BRD v1.2 Wave 1 slices 1 to 4 (21 Oct 2026)

## Wave 1, slices 1 to 4 (current handover)

**Status:** local verification only, with simulated WhatsApp (sandbox provider) and ClamAV's test signature. GitHub
CI, hosted verification, live provider checks and pilot approval are pending. G4 and the sign-in risk are open, with
owner acceptance pending. Nothing has been pushed, deployed or connected, and no spending was made.

Branch `feature/brd-v1.2-wave1`, built on `main` (`1eac98c`). Candidate 3 (`rc3-tested` = `f1bc095`,
`rc3-packaged` = `c3b6d3d`) is unchanged.

| Role | Commit | What was done at exactly this commit | Evidence |
| --- | --- | --- | --- |
| Slice 2 baseline | `4eda821` | Slice 2 reviewed, rechecked and tested | `wave1-slice2-report.md`; `clean-checkout-4eda821.txt` |
| Slice 3 | `0de62ee`, `dcece7b` | Slice 3 reviewed, rechecked and tested | `wave1-slice3-report.md`; clean-checkout files for both |
| Slice 4 reviewed | `264379b` | Independent review: 1 High, 3 Medium, 2 Low | `wave1-slice4-report.md`; `clean-checkout-264379b.txt` |
| Rechecked | `294a79d`, `074644f` | S4-1 to S4-7 verified; N1 found and fixed; N1 verified fixed at `074644f` | Clean-checkout files for both |
| Closure point 1 | `a061494` | Send-time campaign limits; recheck found P2-1 (High) | `clean-checkout-a061494.txt` |
| P2-1 fix | `b1a03bb` | Recheck verified P2-1; found B-1 (Medium) | `clean-checkout-b1a03bb.txt` |
| **Tested and rechecked (final code)** | `ffdc5c7` | B-1 fix. Clean-checkout run and final independent recheck of this exact commit (results below) | `clean-checkout-ffdc5c7.txt`; report section 8 |
| **Packaged** | The commit containing this file (hash in the handover message) | Documents and evidence only. Its code is identical to `ffdc5c7` | Command below |

Tags: `w1s4-tested` = `ffdc5c7`; `w1s4-packaged` = the packaged commit.

```bash
git diff --stat w1s4-tested w1s4-packaged -- apps packages scripts .github package.json pnpm-lock.yaml turbo.json pnpm-workspace.yaml
# expected: no output
```

### Results at `ffdc5c7` (clean checkout)

See `docs/reports/evidence/clean-checkout-ffdc5c7.txt`.

| Check | Result |
| --- | --- |
| Install | Frozen lockfile, installed exactly as locked (Node 22.22.0, pnpm 10.28.0) |
| Secret scan, lint, type check, build | Passed (248 files scanned) |
| Dependency audit (strict, all packages) | **No advisories** |
| Audit-rule unit tests | 14/14 |
| Migrations | 0001–0036 on a fresh database |
| Isolation check (CI guard) | Passed |
| Database roles used by the tests | cf_app, cf_identity, cf_notify, cf_platform: none superuser, none bypasses row security |
| API tests | **449/449 in 29 files** (including the upgrade tests, which use a disposable superuser locally) |
| Browser checks (English and Arabic, three sizes, security policy) | **15/15** in Chromium. Firefox and WebKit not yet run |

**Final independent recheck of `ffdc5c7`:** B-1, P2-1 and N1 verified fixed; nothing at Medium or above; the
reviewer's 156 tests (its probes included) pass. Open: B-2 (Low, not probed; upgrade test required before upgrading any
persistent database with campaign traffic), P2-2 (Low), P2-3 (Info, owner decision), N2 (Info).
G4 and the sign-in risk are open, with owner acceptance pending.

### Archives

Kept outside the repository (they contain it), in the handover folder with `SHA256SUMS.txt`:

| File | Contents |
| --- | --- |
| `conversaflow-<packaged>.zip` | Source tree at `w1s4-packaged` (`git archive`) |
| `conversaflow-<packaged>.bundle` | Full git history: `main`, `feature/brd-v1.2-wave1` and all tags (candidates 1–3, `w1s4-tested`, `w1s4-packaged`); `git bundle verify` reports it okay |

---

# Phase 1, candidates 1 to 3 (20 Oct 2026)

**Status:** development complete; local checks reported passed; GitHub CI, hosted verification and live pilot
approval pending.

Every claim below names the commit that was checked. Nothing has been pushed, deployed or connected.

## Candidate 3 (current)

Built on `rc2-packaged` (`bec9ee8`). Adds M7, M8 and M9, the stronger CI guard, `client.ts` under code-owner
coverage, and the unsupported-browser notice.

| Role | Commit | What was done at exactly this commit | Evidence |
| --- | --- | --- | --- |
| **Reviewed (all candidate 3 changes)** | `c6c51b88dbaabaa860291108751528952a18eca5` | Independent review of M7–M9, the guard and the browser work. No Critical, High or Medium findings; four Low (L-A to L-D) and four informational | `M1-closure-report.md`, "Independent review of candidate 3"; `clean-checkout-c6c51b8.txt` |
| Rechecked (first fixes) | `42823bb6dce50c7ed7ad992146dd3af12c6ed607` | L-B and the email cap verified; L-A, L-C and L-D partly fixed | Closure report; `clean-checkout-42823bb.txt` |
| Rechecked (second fixes) | `4e60aeba731f194edaa398a0bf27fda04fed248c` | L-A verified; L-D verified for six cases; two Low gaps left (L-C creation time, G2 trigger on a privileged-only table) | Closure report; `clean-checkout-4e60aeb.txt` |
| Rechecked (third fixes) | `6f78a895c549b070474f5180e9e9bd527727d295` | L-C verified; G2 verified for its own case; one Low gap left (G3: the pin covered only the function body) | Closure report; `clean-checkout-6f78a89.txt` |
| **Tested and rechecked (final)** | `f1bc0952de1c3139fe9d4806b910382f4a46296a` | **Clean-checkout run:** fresh clone, frozen lockfile, fresh database, restricted roles; results below.<br>**Targeted recheck:** G3 and the invitation-delete item verified; one Low residual risk (G4) documented, owner acceptance pending | `clean-checkout-f1bc095.txt`; closure report |
| **Packaged** | The commit containing this file (hash in the handover message) | Documents and evidence only. Its code is identical to `f1bc095` | Command below |

Tags: `rc3-tested` = `f1bc095`; `rc3-packaged` = the packaged commit.

```bash
git diff --stat rc3-tested rc3-packaged -- apps packages scripts .github package.json pnpm-lock.yaml turbo.json pnpm-workspace.yaml
# expected: no output
```

### Results at `f1bc095` (clean checkout)

See `docs/reports/evidence/clean-checkout-f1bc095.txt`.

| Check | Result |
| --- | --- |
| Install | Frozen lockfile, installed exactly as locked |
| Secret scan, lint, type check, build | Passed (176 files scanned) |
| Dependency audit (strict, all packages) | **No advisories** in production or development and build tools; no exceptions in force |
| Audit-rule unit tests | 14/14 |
| Migrations | 0001–0021 on a fresh database |
| Isolation check (CI guard) | Passed |
| Database roles used by the tests | cf_app, cf_identity, cf_notify, cf_platform: none superuser, none bypasses row security |
| API tests | 247/247 in 17 files |
| Browser checks (English and Arabic, three sizes, security policy, not-found pages, browser notice) | 11/11 in Chromium. Firefox and WebKit are configured for CI and not yet run |

### Differences

| From → to | Size | Security-relevant changes | Reviewed |
| --- | --- | --- | --- |
| `bec9ee8` → `c6c51b8` | 35 files, +1,020 / −149 | **M7:** migration 0016, emailed activation code.<br>**M8:** migration 0017, two-person reset, runbook.<br>**M9:** 72-hour, revocable invitations.<br>**Guard:** privileged pilot/override writers.<br>**CODEOWNERS:** `client.ts`.<br>**Web:** browser notice; Firefox/WebKit projects | Yes, at `c6c51b8` |
| `c6c51b8` → `42823bb` | 19 files, +428 / −59 | Migration 0018: `cf_pilot` owner role, owner-based guard, 72-hour cap trigger, digit filter, reset review list, email cap | Yes, at `42823bb` |
| `42823bb` → `4e60aeb` | 14 files, +168 / −12 | Migration 0019: digit total, creation-based invitation cap. Guard covers all schemas, privileged triggers, rules and views | Yes, at `4e60aeb` |
| `4e60aeb` → `6f78a89` | 3 code files, +59 / −7 (plus evidence) | Migration 0020: business role cannot set an invitation's creation time. Guard flags any writer-owned privileged trigger on any table; reviewed trigger functions pinned to their reviewed body | Yes, at `6f78a89` |
| `6f78a89` → `f1bc095` | 3 code files, +28 / −6 (plus evidence) | Guard pins the whole definition plus owner (G3). Migration 0021: business role loses DELETE on invitations | Yes, at `f1bc095` |

### Evidence files for candidate 3

| File | Commit | Outcome |
| --- | --- | --- |
| `clean-checkout-c6c51b8.txt` | `c6c51b8` | All checks passed (243 API tests) |
| `clean-checkout-42823bb.txt` | `42823bb` | All checks passed (245 API tests) |
| `clean-checkout-4e60aeb.txt` | `4e60aeb` | All checks passed (245 API tests) |
| `clean-checkout-6f78a89.txt` | `6f78a89` | All checks passed (246 API tests) |
| `clean-checkout-f1bc095.txt` | `f1bc095` | All checks passed (247 API tests) — the tested commit |

## Candidate 2 (preserved)

| Role | Commit | Tag | State |
| --- | --- | --- | --- |
| Reviewed | `e18d89fdf750f3c2fbd07e48d0310ab581f0799a` | — | No Critical, High or Medium; L1–L3 found |
| Rechecked | `56cdf5b52fd502c6843fd329d2d3e9aabd28dc14` | — | L1, L2 verified; L3 widened |
| Tested | `58d156f48b4bcd502cc86b5b05de1253eb5d1d42` | `rc2-tested` | Clean checkout passed (230 API tests, 10 browser checks) |
| Packaged | `bec9ee8` | `rc2-packaged` | Documents only on top of `rc2-tested`; zip and bundle archived |

## Candidate 1 (preserved)

| Role | Commit | Tag | State |
| --- | --- | --- | --- |
| Tested and rechecked | `3966c4c4b2a13070143a6f73fe621fdedcbfac3a` | `rc1-tested` | Clean checkout passed (228 API tests, 9 browser checks); F1–F3 verified closed |
| Packaged | `92e9c2e5b655edda295007a574a1a2d3a74ada0e` | `rc1-packaged` | Documents only on top of `rc1-tested`; zip and bundle archived |

The earlier reviewed commits `6972acb` (N1–N4) and `ee77e77` (F1–F3 found) are described in the closure report.

## Still open (not claimed)

- **GitHub:** CI on GitHub (including the first Firefox and WebKit run) and **code-owner enforcement, which stays
  pending** until the organisation, team and `main` ruleset are set up and checked.
- **Hosted verification:**
  - official malware signatures;
  - file-access revocation;
  - storage permissions;
  - session expiry;
  - backup restoration;
  - a real-device browser check.

  These need a hosting decision.
- **Reviews and approvals still to come:** the external security review, Meta verification and App Review, the
  sign-in risk acceptance, and the pilot approval itself.
- **Remaining findings:** the complete numbered list (11 items) is in the closure report. None is Critical, High or
  Medium. L-A to L-D, G2 and G3 are verified closed; G4 is a documented Low residual risk, owner acceptance pending; its
  safeguard (code-owner review of migrations) is pending until enforced and verified on GitHub.
