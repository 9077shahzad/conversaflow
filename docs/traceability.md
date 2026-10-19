# Requirements traceability — Phase 1 (local)

Status values: NOT STARTED · BUILT · VERIFIED (automated tests pass) · BLOCKED · PRODUCTION READY.
Nothing is PRODUCTION READY until human review, penetration test and owner approval.

| Requirement (BRD v1.1) | Database | API | Tests | Status |
| --- | --- | --- | --- | --- |
| FR-001 Sign-up with verified email, company profile | users, auth_tokens, tenants | `POST /v1/auth/signup`, `/verify-email`, `POST /v1/tenants` | auth.test: sign-up and email verification (5) | VERIFIED |
| FR-002 MFA for privileged roles, recovery codes, sessions, rate limits | mfa_factors, mfa_recovery_codes, sessions, permissions.requires_mfa | `/v1/auth/mfa/*`, `/v1/auth/sessions` | auth.test (TOTP 5 incl. per-user limit and no reuse, sessions 3, rate limit 1); rbac.test MFA rule | VERIFIED (passkeys later) |
| FR-003 Create workspace, choose plan, invite users | tenants, subscriptions, invitations | `POST /v1/tenants`, `POST /v1/invitations`, `/accept` | limits.test, rbac.test | VERIFIED (channel connection = Phase 2) |
| FR-004 Subdomain / custom domain | tenants.slug | — | — | NOT STARTED (slug reserved) |
| FR-005 Multiple companies per user; switch clears scope | memberships, sessions.active_tenant_id | `GET /v1/me/tenants`, `POST /v1/me/active-tenant` | isolation.db (dual member), isolation.api (switch refused) | VERIFIED (client cache: M1.7) |
| FR-006 Company profile, hours, holidays, SLA, branches, teams | tenants, tenant_settings, tenant_holidays, branches, teams, team_members | `/v1/settings*`, `/v1/branches`, `/v1/teams*` | settings.test (9) | VERIFIED |
| BRD §3 Roles: owner, admin, supervisor, agent, analyst, custom | roles, role_permissions, membership_roles | `/v1/roles`, `/v1/members/:id/roles` | rbac.test matrix (50) + escalation (11) | VERIFIED |
| BRD §4 Seats enforced transactionally | subscriptions (row lock), memberships | accept invitation | limits.test: 20 concurrent accepts → exactly 2 | VERIFIED |
| BRD §4 Hard quotas, warn at 80/95% | usage_counters, plan_entitlements, entitlement_overrides | `GET /v1/entitlements` | limits.test (metered, parallel) | VERIFIED |
| BRD §4 / §13 tenant_id + RLS on every tenant table | all tenant tables | — | check-rls (CI), isolation.db.test (13) | VERIFIED |
| BRD §18 gate 1: A cannot access B (records) | — | all routes | isolation.api.test records (5) | VERIFIED for Phase 1 routes |
| BRD §18 gate 1: A cannot access B (files) | files (key check constraint) | `/v1/files*` | isolation.api.test files (10) + link revoked on demotion (1) | VERIFIED (local storage driver) |
| FR-207 Safe uploads: type allowlist, ClamAV scan (fail-closed), signed URLs | files.status | `POST /v1/files`, `/link`, `/download` | isolation.api.test, scanner.test (6) | VERIFIED (local); hosted signatures pending |
| BRD §12/§13 Immutable audit events | audit_events (append-only, hash chain) | `/v1/audit-events`, `/verify` | audit.test (6) | VERIFIED |
| BRD §12 Break-glass support access | support_access_grants, platform_staff, platform_audit_events | `/v1/platform/support-grants*`, `/v1/platform/tenants/:id/{files,members}` | platform.test (11), review2.test (4) | VERIFIED |
| BRD §12 Platform owner console | feature_flags, tenant_feature_flags, plan_versions.published_at | `/v1/platform/tenants`, `/plans`, `/features` | platform.test | VERIFIED |
| BRD §16 English/Arabic RTL UI | users.locale, tenants.locale | web app `/en`, `/ar` | Playwright ui.spec (8: readability, RTL, accessibility, 3 sizes) | VERIFIED (local) |
| BRD §17 Observability | — | X-Request-Id on every response | observability.test (2); load smoke in evidence | BUILT (local); hosted telemetry pending |
| BRD §4 Trial, §11 annual prices, retention, automation usage (owner decisions 19 Oct) | trial_policy, trial_caps, plan_versions v2 (draft), retention_policies, usage_events, provider_rates | `/v1/entitlements` | commercial.test (16) | VERIFIED |
