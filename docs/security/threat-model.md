# Threat model — Phase 1 (STRIDE)

Scope: web app, API, worker (notifier), PostgreSQL, Redis, file storage, ClamAV. Not yet in scope: WhatsApp,
payments, AI (threat-modelled when built). Last reviewed: 19 Oct 2026. Owner of this document: engineering.

## Trust boundaries

1. Browser ↔ web app / API (internet; HTTPS in hosted environments).
2. API process ↔ PostgreSQL, using **four separate database roles**: `cf_app` (business data), `cf_identity`
   (sign-in, sessions, MFA), `cf_platform` (platform console), and the worker's `cf_notify` (account emails).
3. API ↔ ClamAV, Redis, object storage (private network in hosted environments).
4. Platform staff ↔ company data (only via approved, time-limited support grants).

## Threats, controls and evidence

| # | Threat (STRIDE) | Control | Evidence (automated test) | Residual risk |
| --- | --- | --- | --- | --- |
| S1 | Spoofing: password guessing | Argon2id; rate limits per email and per IP; same answer for unknown emails | auth.test | Credential stuffing from many IPs → add bot protection at the edge (WAF) |
| S2 | Spoofing: stolen or forged session | httpOnly SameSite cookie; 60-min idle and 12-h absolute expiry (the 12 h cap is enforced inside the database as well); sessions can only be opened through a database function that starts them without MFA; listed and revocable; MFA enrolment ends other sessions | credentials.test, review2.test, auth.test | Session theft via malware on the user's device |
| S3 | Spoofing: MFA bypass or guessing | TOTP per user and per session limits; each code usable once; single-use recovery codes | auth.test | SIM/phone loss handled by recovery codes only; passkeys later |
| T1 | Tampering: SQL injection used to change credentials | `cf_app` has no rights on credential tables or token functions; CI guard fails the build if regained; lint rule bans interpolated SQL | credentials.test, check-rls | Injection inside the identity module itself (few, reviewed queries) |
| T2 | Tampering: audit trail edited | Append-only trigger; per-company hash chain; verification endpoint | audit.test | Database superuser could rewrite and re-chain → off-site log shipping in hosted env |
| T3 | Tampering: prices or billing state changed | Versions frozen once used; drafts can't be subscribed; publishing only by a platform owner, audited; the business API cannot update or delete subscriptions and any subscription it creates is forced to a trial | limits.test, commercial.test, platform.test, review2.test | — |
| R1 | Repudiation: "I never did that" | Audit events with actor, time, IP; request logs with correlation ids | audit.test, observability.test | Logs only local until hosting is approved |
| I1 | Information disclosure: company A sees company B | Forced RLS on every company table (catalogue-driven tests); composite foreign keys; company from session only | isolation.db.test, isolation.api.test | Logic bugs in future modules → the catalogue-driven suite covers new tables automatically |
| I2 | Disclosure: file links shared or reused | Links bound to user + company, 5-minute expiry, permission re-checked at download; storage paths per company | isolation.api.test, hosted-check.test | Hosted run pending a deployment |
| I3 | Disclosure: platform staff browsing customer data | Platform role has NO direct table access; every action is a database function that proves the caller from their **session token** (live, MFA-verified); two-person approval; ≤ 4 h; revocable; every view in the company's audit trail | platform.test, review2.test | Collusion of two platform owners → platform audit log review |
| I4 | Disclosure: secrets in logs | Logs exclude query strings, bodies, cookies, emails | observability.test | — |
| D1 | Denial of service: large or malicious uploads | 16 MB limit; type allow-list; scanner timeout; fail-closed | scanner.test | Volumetric attacks → WAF/rate limiting at the edge |
| D2 | Denial of service: mail provider outage | Queue with back-off and retry; no tokens left behind; token lifetimes capped in the database; emails go to the stored address | credentials.test, review2.test | — |
| E1 | Elevation: member grants themselves more rights | Roles and invitations only within the actor's own permissions; no self role edits; last Owner protected | rbac.test | — |
| E2 | Elevation: app role becomes a privileged role | Login roles own nothing, cannot BYPASSRLS, inherit no roles; CI guard | isolation.db.test, check-rls | — |
| E3 | Malware stored and served | ClamAV scan before storing; infected files never written; only "available" files downloadable | scanner.test | Hosted ClamAV must use official, auto-updated signatures |

## Open items before a live pilot

- Hosted environment: TLS, WAF, private networking, secrets manager, off-site log shipping, backup restore drill.
- Independent code review and penetration test (proposal in the preparation pack).
- Run `file-revocation-check` against staging.
- Replace `'unsafe-inline'` for scripts in the web Content Security Policy with per-request nonces.
- Known by design: a role's `app.user_id` setting is trusted only inside the business API (cf_app), which rechecks membership from the session on every request; privileged actions never trust it (see ADR-025).
