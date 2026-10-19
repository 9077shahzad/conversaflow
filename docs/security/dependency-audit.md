# Dependency audit — production and development/build tools

Audit run on 20 Oct 2026 (UTC 19 Oct), after commit `a32601a`. Command: `pnpm deps:audit`
(`scripts/audit-deps.mjs`), which runs `pnpm audit` over **all** packages, then again over production packages
only to label each advisory's scope.

**The run fails when:**
- any advisory is High or Critical, wherever it sits;
- any advisory at all is in a production dependency.

It also fails if the audit cannot run at all, for example when the registry is unreachable (independent review F1).

**Unless** the advisory is covered by an **approved**, unexpired exception in `docs/security/audit-exceptions.json`
for the scope where it was found. A *proposed* exception never passes in CI. Local evidence runs use
`pnpm deps:audit:local`, which lets a proposed exception through and says so in the report.

CI and the clean-checkout script both install from the frozen lockfile and run this audit.

## Result now

| Scope | Critical | High | Moderate | Low |
| --- | --- | --- | --- | --- |
| Production dependencies | 0 | 0 | 0 | 0 |
| Development and build tools | 0 | 1 (proposed exception, awaiting approval) | 0 | 0 |

## Remaining advisory and proposed exception

| Advisory | Package and path | Severity | Relevance | Status |
| --- | --- | --- | --- | --- |
| GHSA-vfj7-8cjw-p6xm (stack exhaustion on deeply nested patterns) | `braces` 3.0.3 via `tailwindcss > chokidar` (web build) | High | Low. Used only by Tailwind's file watcher at build and development time, on glob patterns from our own configuration. Not in the running application, never sees user input. **No fixed release exists** (3.0.3 is the latest). | Proposed exception, expires 31 Jan 2027, **awaiting your confirmation**. Review on a Tailwind 4 migration or a braces fix. |

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

None accepted yet. The braces exception above needs your confirmation. Until then the strict audit, which CI runs,
**fails** on it. So the first GitHub CI run will be red at this one step unless you approve the exception (checklist A13)
or we migrate to Tailwind 4 (about 1–2 days).
