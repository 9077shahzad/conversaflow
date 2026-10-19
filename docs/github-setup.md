# GitHub setup checklist — Meronatic-owned organisation

Proposed repository: **`conversaflow`** (private). Push approval stays pending until you confirm the organisation.

## You (owner) — about 20 minutes

- [ ] Sign in with a Meronatic-controlled admin account (shared company mailbox, not personal); turn on two-factor authentication.
- [ ] Create the organisation (Free plan is enough) at github.com/organizations/plan, e.g. `meronatic`.
- [ ] Organisation **Settings → Authentication security**: require two-factor authentication for everyone.
- [ ] Add a second Meronatic owner, so access never depends on one person.
- [ ] Create repository **`conversaflow`**: Private, empty (no README, licence or .gitignore).
- [ ] Repository **Settings → Branches**: protect `main` — pull request required, status check `CI / checks` required, no force-push, no deletion.
- [ ] Repository **Settings → Code security**: Dependabot alerts and security updates on (free).
- [ ] Tell me the organisation name and approve the push.

## Me (after your approval)

- [ ] Request access through the GitHub connection (you approve on GitHub; no password or token in chat or code).
- [ ] Push the history from the bundle; confirm the commit hash on GitHub matches the handover.
- [ ] Watch the first pipeline run end to end; preserve the run log and screenshot artefact in `docs/reports/evidence/`.
- [ ] Run the full pipeline once more from a **clean checkout and fresh database** using the restricted database roles, and record the result.

## Rules that stay in force

- Developers get **Write** on the repository only, never Admin.
- No secrets in the repository: `.env` is ignored, `.env.example` holds placeholders, CI fails on a secret-scan hit.
- CI needs **no repository secrets** today; its database passwords are throwaway values for temporary containers.
- Paid GitHub features (Team plan, Advanced Security) need separate approval.
