# Release manifest — Phase 1 handover, 20 Oct 2026

**Status:** development complete; local checks reported passed; GitHub CI and hosted verification pending.

Every claim below names the commit that was checked. Nothing has been pushed, deployed or connected.

## The commits

| Role | Commit | What was done at exactly this commit | Evidence |
| --- | --- | --- | --- |
| **Reviewed (MFA and isolation fixes)** | `6972acb61309cb4586a0af17a2a163745328f5ea` | Second independent recheck: N1–N4 verified closed, no new High or Medium findings | `docs/reports/M1-closure-report.md`, "Second independent recheck" |
| **Reviewed (later security changes)** | `ee77e774c5e4f7376cdccc5abc67b150bcc74f66` | Targeted independent review of everything security-relevant since `6972acb`. Findings F1, F2 (Medium) and F3 (Low) | Closure report, "Targeted independent review" |
| **Tested and rechecked (release candidate)** | `3966c4c4b2a13070143a6f73fe621fdedcbfac3a` | **Clean-checkout run:** fresh clone, frozen-lockfile install, fresh database, restricted roles; every check passed.<br>**Independent recheck:** F1–F3 and migration 0013 verified closed; nothing new above Informational | `docs/reports/evidence/clean-checkout-3966c4c.txt`; closure report, "Recheck of the fixes at 3966c4c" |
| **Packaged** | The commit that contains this file (hash given in the handover message) | Documents and evidence only. Its code, migrations, scripts, CI and lockfile are identical to `3966c4c` | Check with the command below |

To confirm that the packaged code is identical to the tested and rechecked code:

```bash
git diff --stat 3966c4c HEAD -- apps packages scripts .github package.json pnpm-lock.yaml turbo.json
# expected: no output
```

## Results at the tested commit `3966c4c`

| Check | Result |
| --- | --- |
| Install | `pnpm install --frozen-lockfile`: installed exactly as locked |
| Secret scan | Passed (151 files) |
| Lint, type check, build | No problems; 6/6 type-check tasks; all packages built |
| Dependency audit, all packages | Production: 0 advisories. Development/build tools: 1 High (braces, no fix exists), proposed exception awaiting your approval. The strict CI audit **fails** on it until you approve (A13); the local evidence run reports it and continues |
| Migrations | 0001–0013 applied to a fresh database |
| Isolation check (CI guard) | Passed |
| Database roles used by the tests | cf_app, cf_identity, cf_notify, cf_platform: none superuser, none bypasses row security |
| API tests | 228/228 in 16 files |
| Browser checks (English and Arabic, three screen sizes, security policy) | 9/9 |

The reviewer reproduced these independently at `3966c4c`: 228/228 API tests, and 9/9 browser checks on two runs in a row.

## Differences between the commits

| From → to | Size | Security-relevant code changed | Reviewed? |
| --- | --- | --- | --- |
| `6972acb` → `ee77e77` | 55 files, +2,239 / −512 | **Content Security Policy:** middleware, csp.ts, next.config, layout.<br>**Pilot enrolment and mandatory two-step sign-in:** migration 0011, guard, rbac, files, platform service and controllers.<br>**Security notices:** migration 0012, notifier.<br>**CI guard:** check-rls.<br>**Dependency upgrades:** package.json, lockfile.<br>**New scripts:** audit-deps.mjs, verify-clean-checkout.sh.<br>**CI:** ci.yml | Yes, in full, at `ee77e77` |
| `ee77e77` → `3966c4c` | 22 files, +355 / −85 | **Fixes for F1–F3:** audit-deps.mjs, verify-clean-checkout.sh, middleware.ts, csp.ts, next.config.mjs; API security headers in app.ts.<br>**Narrower grants:** migration 0013.<br>**Plus:** a postcss-selector-parser override | Yes, in full, at `3966c4c` |
| `3966c4c` → packaged | Documents and evidence only | None | Not needed (no code) |

Earlier non-code commits in the same range (`9daa683`, `61180f6`, `4f39450`, `93e99f9`) hold documents, workbooks and
the PostCSS override. The override was reviewed as part of `6972acb` → `ee77e77`.

## Earlier evidence files kept for the record

| File | Commit | Outcome |
| --- | --- | --- |
| `clean-checkout-a32601a.txt` | `a32601a` | Did not complete. The disposable database could not start because the temporary folder was private to one account. The script was fixed in `ee77e77` |
| `clean-checkout-ee77e77.txt` | `ee77e77` | One browser check failed (page title missing under per-request rendering). Fixed in `3966c4c` |
| `Phase1-evidence-run.txt` | `61180f6` | Earlier local run (213 API tests, 8 browser checks at that commit) |

## Still open (not claimed)

- GitHub CI on GitHub, and the clean-checkout run there: needs the organisation and push approval (A3). The first CI run will fail at the audit step unless you approve the exception (A13).
- Hosted verification:
  - official malware signatures;
  - file-access revocation;
  - storage permissions;
  - session expiry;
  - backup restoration.

  These need a hosting choice and approval (A4).
- The external security review (A5).
- Five informational items from the recheck (R4-1 to R4-5 in the closure report).
