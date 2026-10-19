# ConversaFlow by Meronatic

Multi-company (multi-tenant) customer conversation platform, WhatsApp-first. Proprietary — © Meronatic. All rights reserved.

**Status: Milestone 1 (foundation) — local development only.** No live integrations, no paid services, no public deployment.

## What exists today

| Area | Location | State |
| --- | --- | --- |
| Database schema, migrations, row-level security | `packages/database/migrations` | Built and tested |
| Isolation guard run in CI | `packages/database/src/check-rls.ts` | Built and tested |
| API: sign-up, email verification, sign-in, MFA, sessions, password reset | `apps/api/src/modules/auth.service.ts` | Built and tested |
| API: companies, members, invitations, roles, custom roles | `apps/api/src/modules` | Built and tested |
| API: plans, seat limits, usage limits | `apps/api/src/modules/entitlements.service.ts` | Built and tested (no payments) |
| API: audit trail (append-only, hash-chained) | `apps/api/src/modules/audit.service.ts` | Built and tested |
| API: files (company folders, signed links, malware-scan hook) | `apps/api/src/modules/files.service.ts` | Built and tested (local storage driver) |
| Worker | `apps/worker` | Scaffold only |
| Web app | `apps/web` | Not started (M1.7) |
| Infrastructure as code | `infrastructure` | Not started (M1.8, plan only) |

## Run the checks locally

Requirements: Node 22, pnpm 10, PostgreSQL 16 binaries and Redis 7 installed locally (or Docker, see `docker-compose.yml`).

```bash
pnpm install
pnpm lint && pnpm build && pnpm typecheck
pnpm secrets:scan
pnpm test:local      # starts a throw-away PostgreSQL + Redis, migrates, runs the isolation check and all tests
```

## Security model in one paragraph

Every company-owned table carries `tenant_id` and has PostgreSQL row-level security **forced**. The API connects as
`cf_app`, which owns nothing and cannot bypass RLS. Each request runs in one transaction that sets the company and
user with transaction-local settings, so the database itself refuses other companies' rows even if application code
has a bug. The company always comes from the signed-in session after a membership check — never from the URL or body.
Authentication functions that must run before a user is known are owned by a separate non-login role (`cf_auth`).
See `docs/adr/` and `apps/api/test/isolation.*.test.ts`.

## Docs

- `docs/adr/` — architecture decision records
- `docs/github-setup.md` — creating the Meronatic-owned GitHub organisation and repository
- `docs/traceability.md` — requirement → code → test
- `docs/reports/` — milestone reports with test evidence
