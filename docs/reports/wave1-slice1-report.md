# Wave 1, slice 1 — report (20 Oct 2026)

Branch `feature/brd-v1.2-wave1`, starting from `1eac98c` (tip of `main`). Candidate 3 (`rc3-tested` = `f1bc095`,
`rc3-packaged` = `c3b6d3d`) is unchanged.

## Commits

| Commit | What | Evidence |
| --- | --- | --- |
| `3c6d20dc4731e3bf12354cc86c8da0d45c3f6b48` | Slice 1: migration 0022, sandbox channel, signed webhook intake, contacts, conversations, inbox API; inventory and competitive evidence | Independently **reviewed**: 1 Medium, 5 Low, notes. Clean checkout **failed** on one timing-dependent test (`clean-checkout-3c6d20d.txt`), kept as evidence |
| `1665c0fc28994c275b2fe6fa229d7927dbe45b25` | Review fixes (migration 0023 and code) and the eight planning documents | Clean checkout **passed** (`clean-checkout-1665c0f.txt`); targeted recheck **verified** all fixes |

## Results at `1665c0f` (clean checkout, local)

Fresh clone, frozen lockfile, fresh PostgreSQL 16 / Redis 7 / ClamAV (test signature), restricted roles.

| Check | Result |
| --- | --- |
| Secret scan, lint, type check, build | Passed |
| Dependency audit (strict, all packages) | No advisories |
| Migrations | 0001–0023 |
| Isolation check (CI guard) | Passed |
| API tests | 275/275 in 18 files (messaging 28) |
| Browser checks | 12/12 (Chromium) |

## Review findings

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| M1 | Late customer message (older timestamp) did not block an uninformed reply | Medium | **Fixed and verified** (arrival counter) |
| M2 | Future provider timestamp could hold the 24-hour window open | Low | **Fixed and verified** |
| M3 | Same idempotency key from two people caused a server error | Low | **Fixed and verified** |
| M4 | Webhook bodies over 100 kB got a 500 | Low | **Fixed and verified** (3 MB limit on webhooks only; 413 above) |
| M5 | CI guard did not constrain the routing role `cf_channel` | Low | **Fixed and verified** for `cf_channel` |
| M5-general | Guard does not flag *any* non-business role granted read access to company tables plus a privileged function exposing it (needs a migration) | Low | **Open** — next guard change (allowlist of roles and columns that may read company tables). Same class as the documented residual risk G4: only a merged migration can introduce it, so code-owner review is the backstop (pending GitHub) |
| L6 | Claim-race test was timing-dependent | Low | **Fixed and verified** (5 consecutive passes) |
| Notes | Keyword punctuation/diacritics; sandbox default; timing-safe token | Info | **Fixed and verified** |
| Open (planned W1.3) | A crash between commit and send leaves a message "queued"; a status arriving after the orphan sweep is not applied; number-ownership proof before live WhatsApp | Info | Planned |
| Product decisions | Should a supervisor's internal note block an agent's reply? Show "last reply failed" prominently? Treat emoji after STOP as opt-out? | Info | For the owner |

## Evidence kept separate

| Level | State |
| --- | --- |
| Local | Passed at `1665c0f` as above |
| GitHub CI | Pending (GitHub not linked; push approval covers `github.com/9077shahzad/conversaflow` once linked) |
| Hosted | Pending (no hosting approved) |
| Pilot | Pending |
