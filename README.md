# ConversaFlow by Meronatic

Multi-company (multi-tenant) customer conversation platform, WhatsApp-first. Proprietary — © Meronatic. All rights reserved.

**Status: Milestone 1 locally checked; Phase 1 build complete locally. GitHub CI and hosted verification pending.**
No live integrations, no paid services, no public deployment.

## What exists today

| Area | Location | State |
| --- | --- | --- |
| Database schema, migrations, row-level security, four restricted roles | `packages/database/migrations` | Built and tested (196 API tests) |
| Isolation and credential-separation guard run in CI | `packages/database/src/check-rls.ts` | Built and tested |
| Sign-up, verification, sign-in, MFA, session expiry, password reset | `apps/api/src/modules/auth.service.ts` | Built and tested |
| Companies, members, invitations, roles, settings, holidays, branches, teams | `apps/api/src/modules` | Built and tested |
| Plans, trial policy and caps, limits, automation metering, Meta rate table | `apps/api/src/modules/entitlements.service.ts`, `provider-rates.ts` | Built and tested (no payments) |
| Audit trail (append-only, hash-chained); request logs with correlation ids | `audit.service.ts`, `http/request-log.ts` | Built and tested |
| Files with ClamAV scanning (fail-closed) and signed links | `files.service.ts`, `core/storage.ts` | Built and tested (local storage driver) |
| Platform console with token-bound, two-person, time-limited support access | `platform.service.ts`, migrations 0008–0009 | Built and tested |
| Notifier worker (account emails; only role that mints tokens) | `apps/api/src/worker/notifier.ts`, `worker.ts` | Built and tested |
| Web app, English and Arabic (IBM Plex Sans Arabic, RTL) | `apps/web` | Built; 8 browser checks at 3 screen sizes |
| Hosted verification: file-revocation check | `apps/api/src/verification/file-revocation-check.ts` | Ready; hosted run pending |
| Threat model, ADRs, traceability, closure report | `docs/` | Written |
| Infrastructure as code | `infrastructure` | Not started (awaits hosting decision) |

## Run the checks locally

Requirements: Node 22, pnpm 10, PostgreSQL 16 binaries and Redis 7 installed locally (or Docker, see `docker-compose.yml`).

```bash
pnpm install
pnpm lint && pnpm build && pnpm typecheck
pnpm secrets:scan
pnpm test:local      # throw-away PostgreSQL + Redis + ClamAV; migrates, runs the isolation guard and all 196 tests
pnpm --filter @conversaflow/web e2e   # builds the web app and runs the English/Arabic browser checks (needs Chromium)
```

Requirements for the local harness: Node 22, pnpm 10, PostgreSQL 16, Redis 7 and ClamAV (`clamav-daemon`) installed.
A full handover run with output is in `docs/reports/evidence/M1-handover-run.txt`.

## Security model in one paragraph

Every company-owned table carries `tenant_id` and has PostgreSQL row-level security **forced**. Four restricted
login roles share the work: `cf_app` (business data; no rights over credentials, sessions, tokens or billing state),
`cf_identity` (sign-in and MFA; opens sessions only through a capped function), `cf_notify` (the worker; the only
role that can mint email tokens) and `cf_platform` (the owner console; no direct table access — every action is a
database function that proves the caller from their session token). The company always comes from the signed-in
session after a membership check, never from the URL or body. The CI guard (`check-rls.ts`) fails the build if any
of these rules regresses. See `docs/security/threat-model.md`, `docs/adr/` and `apps/api/test/`.

## Docs

- `docs/adr/` — architecture decision records
- `docs/github-setup.md` — creating the Meronatic-owned GitHub organisation and repository
- `docs/traceability.md` — requirement → code → test
- `docs/reports/` — milestone reports with test evidence
