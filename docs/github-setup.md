# GitHub set-up — Meronatic-owned organisation (owner steps)

Revised 20 Oct 2026. Proposed repository: **`conversaflow`**, **private**.

The push, any GitHub purchase, external submissions and deployment each stay pending their own approval.

## 1. Which GitHub plan is needed, and what it costs

**GitHub Free is not enough for the protections we want.** On GitHub's own documentation, protected branches and
rulesets (required pull requests, required reviews, required status checks, code-owner review) are available for
**private** repositories only on GitHub Pro, Team or Enterprise. On GitHub Free for organisations they work only on
public repositories. The repository stays private, so the organisation needs **GitHub Team**.

| Item | Figure (GitHub's pricing page, read 20 Oct 2026) |
| --- | --- |
| GitHub Team | **$4 per user per month for the first 12 months**. The page does not state the price after the first 12 months: confirm it on the upgrade screen before you approve the purchase |
| Members who need a paid seat now | 2: you and the second Meronatic owner. The Claude connection is a GitHub App, not a member, and takes no seat. Each developer added later is one more seat |
| Recurring cost, 2 seats | **$8 per month, about $96 for the first year**, before any tax GitHub adds |
| CI minutes included with Team | 3,000 minutes a month on GitHub-hosted runners (private repositories) |
| CI price beyond the allowance | Linux 2-core runner: $0.006 per minute |
| Expected CI use | One run of the `CI` workflow is expected to take about 12–18 minutes (install, three browsers, ClamAV, tests). At about 40 runs a month (pull-request pushes plus merges to `main`) that is roughly 500–750 minutes, well inside 3,000 |
| Expected CI charge | **$0 a month**, with the Actions budget set to $0 so that usage above the allowance is blocked rather than billed |
| Artifact storage | 2 GB included; CI keeps only the screenshots (a few MB per run) |
| Dependabot alerts and security updates | Included, no charge |

The import and the first CI run can happen on GitHub Free (2,000 minutes a month), because they need no protection
rules. **The upgrade to Team is needed only at step 8, before protection is switched on.** No purchase is made
until you approve it.

Sources: GitHub Docs, "About protected branches" and "Available rules for rulesets" (availability notes); GitHub
pricing page; GitHub Docs, "GitHub Actions billing" (included minutes and per-minute rates).

## 2. Names

- **Organisation:** `meronatic-group`, matching MERONATIC SOLUTIONS GROUP, LLC. Fallback: `meronatic-solutions`.
  The name `meronatic` is already taken by an existing GitHub account. If that account is yours, keep it as your
  personal login and do not convert it.
- **Team:** `security-owners`, **visible** (GitHub ignores a secret team in CODEOWNERS), with explicit **Write**
  access to the repository. Code owners must have write access.
- **Required status check:** **`checks`**. That is the name GitHub Actions reports for the single job in
  `.github/workflows/ci.yml` (workflow `CI`, job id `checks`, no matrix). On a pull request it is shown as
  "CI / checks (pull_request)", but the name you select in the ruleset is `checks`, with source **GitHub Actions**.

## 3. The sequence

Steps 1–5 are yours and cost nothing. Step 6 is mine and needs your push approval. Step 8 needs your purchase
approval.

| # | Who | Step | Done when |
| --- | --- | --- | --- |
| 1 | You | **Secure the admin login.** Sign in to GitHub with a Meronatic-controlled account (company mailbox, not personal). Settings → Password and authentication → turn on two-factor authentication | 2FA shows as enabled |
| 2 | You | **Create the organisation on Free for now.** github.com/organizations/plan → **Free** → name `meronatic-group` → contact email the company mailbox → "This organisation belongs to: a business" → MERONATIC SOLUTIONS GROUP, LLC | The organisation page opens |
| 3 | You | **Lock down membership.** Organisation Settings → Authentication security → **Require two-factor authentication**. Member privileges → base permission **No permission**; repository creation **off** for members. Invite the second Meronatic owner with role **Owner** | Second owner has accepted |
| 4 | You | **Create the team.** Teams → New team → `security-owners`, visibility **Visible**, members: you and the second owner | Team page lists both |
| 5 | You | **Create the repository and its settings.** New repository `conversaflow`, **Private**, completely empty (no README, licence or .gitignore). Then in its Settings:<br>• **Collaborators and teams** → Add teams → `security-owners` → role **Write**.<br>• Features: Wikis off, Projects off.<br>• Pull requests: allow squash merging only; turn on "Automatically delete head branches".<br>• Actions → General: allow GitHub Actions; workflow permissions **Read repository contents and packages permissions**.<br>• Organisation Settings → Billing → Budgets: set the Actions budget to **$0** with "stop usage" | The empty repository shows the team with Write |
| 6 | Me, after push approval | **Initial import.** I connect through GitHub's approval screen (no password or token in chat or code). I push the full history to `main` with all tags, then confirm on GitHub that `rc1-*`, `rc2-*` and `rc3-*` point at the hashes in the release manifest. No protection is on yet, by design: a ruleset that requires a pull request would block the first push, and GitHub only offers `checks` once it has run | Hashes match the manifest |
| 7 | GitHub, then me | **First CI run.** The push to `main` starts workflow `CI`, job `checks`, which includes the first Chromium, Firefox and WebKit browser checks. I record the result, the run link and the duration in `docs/reports/evidence/github-ci-first-run.md`. A red run is a confirmed blocker: I fix only that, through a pull request | `checks` is green on the imported commit |
| 7a | Me, you review | **CODEOWNERS configuration commit.** A pull request that only replaces the placeholder `@MERONATIC-ORG/security-owners` with `@meronatic-group/security-owners` in `.github/CODEOWNERS`. I confirm GitHub shows no CODEOWNERS errors on the file (it flags an unknown team or one without write access). The second owner reviews and merges. It is recorded as a configuration commit in the release manifest, separate from the tested code | Merged; `checks` green on the PR; no CODEOWNERS errors |
| 8 | You, after purchase approval | **Upgrade to Team.** Organisation Settings → Billing and plans → upgrade to **Team** for 2 seats. Confirm the price shown, including the price after the first 12 months, before accepting | Plan shows "Team" |
| 9 | You | **Protect `main`.** Repository Settings → Rules → Rulesets → New branch ruleset, name `main protection`, enforcement **Active**, target the default branch, **no bypass list**:<br>• Require a pull request before merging, 1 approval, **Require review from Code Owners**, dismiss stale approvals on new commits.<br>• **Require status checks to pass**: add `checks`, source GitHub Actions.<br>• **Block force pushes**; **Restrict deletions**.<br>Then Settings → Code security: Dependabot alerts and Dependabot security updates on | The ruleset shows as Active |
| 10 | Me and you | **Verify protection** (evidence in `docs/reports/evidence/github-protection-verification.md`):<br>• a direct push to `main` is refused;<br>• a force push is refused;<br>• a test pull request touching a code-owned file (`docs/security/`) cannot merge while `checks` is pending or failing;<br>• it cannot merge with an approval from someone outside `security-owners`, nor by its own author;<br>• it merges only after a `security-owners` approval with `checks` green. The test PR is then closed without merging | Every case behaves as listed |

Only after step 10 do the records change "code-owner enforcement: pending" to "enforced and verified on
<date>, ruleset `main protection`". Until then it stays **pending** everywhere, and so do the safeguards for
database changes that depend on it (the closure report's G4).

**Note on approvals.** A pull-request author cannot approve their own pull request. With two owners, the owner who
did not open a pull request approves it. Pull requests I open through the connection appear under the account that
authorised the connection, so the other owner approves those.

## 4. What I need back from you

**After steps 1–5 (now):**

| Item | Example |
| --- | --- |
| Repository URL (you confirm it before the push) | `https://github.com/meronatic-group/conversaflow` |
| Organisation name | `meronatic-group` |
| Team name and visibility | `security-owners`, Visible, Write on `conversaflow` |
| GitHub usernames of the two owners | `@your-username`, `@second-owner` |
| Confirmation | "2FA required for the organisation; repository private and empty; Actions budget $0; push approved" |

**Later, separately:** purchase approval for GitHub Team (step 8), and a note when the ruleset is Active (step 9),
so we can run the verification in step 10 together.

## 5. Rules that stay in force

- Developers get **Write** on the repository, never Admin.
- No secrets in the repository: `.env` is ignored, `.env.example` holds placeholders, and CI fails on a secret-scan
  hit. CI needs no repository secrets today.
- Code-owner review covers security records, CI, database migrations, security scripts, configuration files and
  access-control code. It is **pending** until step 10 passes.
- Paid GitHub features beyond Team (larger runners, Advanced Security, Copilot) need their own approval.
