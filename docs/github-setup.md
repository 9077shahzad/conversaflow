# GitHub set-up — Meronatic-owned organisation (owner steps)

Proposed private repository: **`conversaflow`**. Push approval stays pending until you confirm the repository URL.
Free plan; about 20 minutes. Paid GitHub features need separate approval.

**Recommended organisation name:** `meronatic-group`, matching MERONATIC SOLUTIONS GROUP, LLC. Fallback:
`meronatic-solutions`. The name `meronatic` is already taken by an existing GitHub account. If that account is
yours, keep it as your personal login; do not convert it.

## Your seven steps

1. **Secure the admin login.** Sign in to GitHub with a Meronatic-controlled account (a company mailbox, not a
   personal one). Turn on two-factor authentication: Settings → Password and authentication.
2. **Create the organisation.** Go to github.com/organizations/plan, choose **Free**, name it `meronatic-group`,
   contact email = the company mailbox, and "This organisation belongs to: a business" → MERONATIC SOLUTIONS
   GROUP, LLC.
3. **Lock down membership.** Organisation Settings → Authentication security: **Require two-factor
   authentication**. Settings → Member privileges: base permission **No permission**; repository creation
   **disabled** for members. Then invite a second Meronatic owner as **Owner**.
4. **Create the team.** Teams → New team **`security-owners`**: you and the second owner.
5. **Create the repository.** New repository **`conversaflow`**: **Private**, completely empty (no README,
   licence or .gitignore). Then, in its Settings:
   - Features: Wikis off, Projects off.
   - Pull requests: allow squash merging only; turn on "Automatically delete head branches".
   - Actions → General: "Allow GitHub Actions" for this repository; workflow permissions **Read repository contents**.
6. **Protect `main`.** Settings → Rules → Rulesets → New branch ruleset, target `main`:
   - Require a pull request before merging, with 1 approval.
   - Tick **Require review from Code Owners**.
   - Require status checks to pass: **`CI / checks`** (it appears after the first run).
   - Block force pushes; restrict deletions.
   - Settings → Code security: turn on Dependabot alerts and Dependabot security updates (free).
7. **Send me the details below** and approve the push. I connect through GitHub's own approval screen, never with
   a password or token in chat or code.

## What I need back from you

| Item | Example |
| --- | --- |
| Repository URL | `https://github.com/meronatic-group/conversaflow` |
| Organisation name | `meronatic-group` |
| Code-owner team name | `security-owners` |
| GitHub usernames of the two owners | `@your-username`, `@second-owner` |
| Confirmation | "2FA required, `main` protected with code-owner review, push approved" |

## After your approval (my steps)

- Connect through GitHub's approval, push the full history and tags, and confirm on GitHub that the commit hashes
  match the release manifest.
- Replace the placeholder `@MERONATIC-ORG/security-owners` in `.github/CODEOWNERS` with the real team, in the first
  pull request.
- Watch the first CI run (Chromium, Firefox and WebKit browser checks included) and keep its logs in
  `docs/reports/evidence/`.

## Rules that stay in force

- Developers get **Write** on the repository, never Admin.
- No secrets in the repository: `.env` is ignored, `.env.example` holds placeholders, and CI fails on a secret-scan
  hit.
- CI needs no repository secrets today.
- Code-owner review covers security records, CI, database migrations, security scripts, configuration files and
  access-control code. It is enforced only once step 6 is done.
