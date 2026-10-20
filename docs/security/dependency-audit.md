# Dependency audit — production and development/build tools

Updated for candidate 2 (20 Oct 2026). Command: `pnpm deps:audit`
(`scripts/audit-deps.mjs`), which runs `pnpm audit` over **all** packages, then again over production packages
only to label each advisory's scope.

**The run fails when:**
- any advisory is High or Critical, wherever it sits;
- any advisory at all is in a production dependency.

It also fails if the audit cannot run at all, for example when the registry is unreachable (independent review F1).

**Unless** the advisory is covered by an **approved**, unexpired exception in `docs/security/audit-exceptions.json`
for the scope where it was found. A *proposed* exception never passes in CI. `pnpm deps:audit:local` exists for local investigation only; the evidence runs use the strict audit.

CI and the clean-checkout script both install from the frozen lockfile and run this audit.

## Result now (candidate 2)

| Scope | Critical | High | Moderate | Low |
| --- | --- | --- | --- | --- |
| Production dependencies | 0 | 0 | 0 | 0 |
| Development and build tools | 0 | 0 | 0 | 0 |

No exceptions are in force. The strict audit (CI and the clean-checkout run) passes.

## braces (GHSA-vfj7-8cjw-p6xm) — evidence and resolution

| | |
| --- | --- |
| Advisory | GHSA-vfj7-8cjw-p6xm, CVE-2026-93687, published 18 Sep 2026; CVSS v4 8.7 (High), availability only; CWE-674 uncontrolled recursion |
| What triggers it | Deeply nested brace patterns, under the length limit, passed to braces: the process crashes with a stack overflow |
| Installed version (candidate 1) | braces 3.0.3, the latest release |
| Dependency paths (candidate 1) | `apps/web` (dev) → tailwindcss 3.4.19 → chokidar 3.6.0 → braces; → fast-glob 3.3.3 → micromatch 4.0.8 → braces; → micromatch 4.0.8 → braces |
| Official fix status | None. The advisory lists no patched version, and braces 3.0.3 (May 2024) is the latest release |
| Actual exposure | Build and development time only, on glob patterns from our own Tailwind configuration. Not in the running application, never given user input. Worst case: a crashed local build |
| Options considered | (1) Approve a time-limited exception. (2) Patch braces ourselves (pnpm patch), which needs ongoing maintenance. (3) Replace the dependency by moving to Tailwind CSS 4, which has none of these packages |
| Decision taken (candidate 2) | Option 3 (ADR-031). The exception was withdrawn without ever being approved. Consequence: modern browsers only (Safari 16.4+, Chrome 111+, Firefox 128+) |

## Exception policy (for any future case)

An exception counts only if it names the advisory and package, its scope (production or development), the dependency
path, the reason, an **owner**, an **approver**, status `approved`, an **expiry** date and a **review** date before the
expiry. An overdue review, an expired date, a missing field or a finding outside the stated scope fails the audit.
These rules have unit tests (`pnpm test:scripts`, 14 cases). Edits to the exceptions file need a code owner's review
once GitHub is configured (`.github/CODEOWNERS`, enforcement pending).

## Resolved in this round

| Advisory | Package | Severity | Where | How it was resolved |
| --- | --- | --- | --- | --- |
| GHSA-5xrq-8626-4rwp | vitest (UI server file read/exec) | Critical | API tests | vitest 2.1 → 4.1.12 |
| GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | tinypool (prototype pollution to code execution) | Critical ×2 | via vitest | Removed with vitest 4 |
| GHSA-82fw-gwwq-j7x9 | vitest, @vitest/mocker (path traversal) | Moderate ×2 | API tests | vitest 4.1.12 |
| GHSA-fx2h-pf6j-xcff, GHSA-4w7w-66w2-5vf9, GHSA-v6wh-96g9-6wx3 | vite (dev-server path bypasses; Windows-only hash leak) | High, Moderate ×2 | via unplugin-swc | vite 7.3.7, unplugin-swc 2.0 |
| GHSA-67mh-4wv8-2f99 | esbuild (dev server readable by websites) | Moderate | via vite | Newer esbuild with vite 7 |
| GHSA-rj75-hqrm-r3gf | postcss-selector-parser (CPU exhaustion) | Moderate | Tailwind build | Override to 7.1.6; generated CSS byte-identical (SHA-256 checked) |
| Four PostCSS advisories (2 high, 2 moderate) | postcss | High ×2, Moderate ×2 | Next.js build | Override to 8.5.31 (commit `61180f6`) |

None of the resolved items were in code that runs in production. All affected test runners, development servers or
build steps.

## Accepted exceptions

None.
