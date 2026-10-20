# Pilot readiness — owner checklist and remaining blockers

**Phase 1 status:** development complete; local checks reported passed; GitHub CI and hosted verification pending.
Live pilot approval remains pending those checks and the conditions below.

Updated 20 Oct 2026 (candidate 2). The owner decision pack (Claude doc "ConversaFlow — Owner Decision Pack") holds
each decision with its evidence. Nothing has been bought, submitted, sent, connected or deployed. Already done on your
decisions of 20 Oct:

- two-step sign-in is mandatory for every pilot user;
- each pilot company has a separate 10-seat allowance, with the standard trial allowance unchanged;
- annual pricing approval is on hold.

## A. Your decisions

| # | Decision | My recommendation | Cost or consequence | What to open |
| --- | --- | --- | --- | --- |
| A1 | Confirm MERONATIC SOLUTIONS GROUP, LLC (Delaware) as the contracting and Meta entity | Confirm | No cost. Until confirmed, nothing can go to Meta, and the legal documents cannot name a party | Prep pack → *Meta business verification pack*, "Before anything is submitted" |
| A2 | Approve the Meta document set, then the submission | Hold the Certificate of Formation, the IRS EIN letter, and a bank statement or utility bill, all in the exact legal name. First check Meta's own accepted-document list in your browser (the one point still unresolved) | No fee. Verification typically takes days to weeks. It is the longest chain before the pilot | Prep pack → Meta section, "At a glance: confirmed, partner guidance, unresolved" |
| A3 | Create the Meronatic GitHub organisation, then approve the push of `conversaflow` | Do it now: about 20 minutes | Free plan. This unlocks the first CI run and the clean-checkout run on GitHub (B2) | `docs/github-setup.md` → "You (owner)" |
| A4 | Choose the hosting provider (selection only; purchase is a later approval) | AWS Frankfurt, with Scaleway as the lower-cost alternative | Provisional: about $442 a month for the pilot (≈ $1,306 over 90 days), about $1,574 at growth. Scaleway is about €302–352 for the pilot. The next step is a Terraform plan, which creates nothing and costs nothing | `docs/readiness/hosting-comparison.md` |
| A5 | Approve contacting security-review suppliers for quotations | Approve sending the request to all three: Cure53, Doyensec, Cyphere | Contact is free. The review itself is estimated at 11–15 tester-days, about €8,000–22,000; a separate approval follows the quotes | `docs/readiness/security-review-rfq.md` (draft request and shortlist) |
| A6 | **Changed:** decide whether to build M7 (email-confirmed authenticator), M8 (audited two-step reset) and M9 (72-hour pilot invitations) before the pilot; the acceptance is then finalised for signature (still pending) | Build M7–M9 before the first invitation | About 3 days plus independent review. With M7, takeover would also need the user's mailbox | `docs/readiness/pilot-mfa-residual-risk.md` |
| A7 | Support offer for Starter and Growth (annual pricing stays on hold) | Starter: 15 min a month, optional $99 onboarding. Growth: 45 min a month and $199 onboarding. Extra support at $60 an hour | At $40 an hour, annual margins become Starter 24% and Growth 31% (from −17% and −16%) | `docs/readiness/pricing-support-proposal.md` and `ConversaFlow-Pricing-Support-Model.xlsx` |
| A8 | Business plan's included support | Reduce from 3 hours to 2 hours a month | At $40 an hour, Business keeps only 10% on annual billing with 3 hours, 32% with 2 hours | Same proposal, "What this tells us" |
| A9 | Pilot length and spending cap (both proposals) | $6,500 for three companies; $9,500 if you choose five | The expected subsidy is $5,224 or $7,837 (support time, hosting, running costs), with a review at 80% of the cap. The security review is separate | Workbook → "Pilot subsidy" |
| A10 | Name the pilot companies (one per sector); invitations stay with you | Choose once A1, A4 and A5 are in motion | Each gets 10 seats for 90 days and mandatory two-step sign-in, set in the console when you approve | `docs/readiness/pilot-synthetic-examples.md` (profiles that fit) |
| A11 | Name the native Arabic business reviewer | Someone who writes customer messages in Gulf business Arabic | About 2 hours of their time. Workbook updated: 104 strings across 10 screens (the new not-found page added three) | `ConversaFlow-Arabic-Review.xlsx` (Instructions sheet) |
| A12 | Instruct counsel on the legal documents | Terms of service, privacy notice, data processing agreement, acceptable use policy and the pilot agreement | Counsel fees, unknown. The pilot cannot start without them | Prep pack → "Proposed pilot terms" |
| A13 | **Changed:** the braces exception is no longer needed (Tailwind 4 removed the package; strict audit passes with no advisories). Decide instead whether to accept Tailwind 4's modern-browser requirement | Accept | Safari 16.4+ (iOS 16.4, March 2023), Chrome 111+, Firefox 128+. If older devices are needed, revert and approve a time-limited exception | `docs/security/dependency-audit.md`; ADR-031 |

## B. Verification still to run (development side, after the approvals above)

| # | Blocker | Evidence needed | Next action |
| --- | --- | --- | --- |
| B1 | Independent review of each candidate's security changes | Reviewer's verdict for the exact commit | Candidate 1 done (`3966c4c`). Candidate 2 (`e18d89f`): review in progress. See `docs/reports/release-manifest.md` |
| B2 | GitHub CI and the clean-checkout run on GitHub | A green run for the pushed commit, with logs kept | Needs A3. The same steps already run locally from a clean checkout |
| B3 | Malware scanning in hosting | `freshclam` installs and updates official signatures; clamd runs with `TZ=UTC`; startup reports signatures current; uploads refused when signatures are missing or outdated, or the scanner is down or slow | Needs A4 |
| B4 | File-access revocation in hosting | Links refused after removal, role change or expiry, through the real storage | Needs A4 |
| B5 | Storage permissions in hosting | Private bucket, application-only access, encryption on | Needs A4 |
| B6 | Session expiry in hosting | 60 minutes idle, 12 hours absolute, through the real load balancer | Needs A4 |
| B7 | Backup restoration | A timed point-in-time restore of staging, with the data loss recorded | Needs A4 |
| B8 | Sign-in risk mitigations M1–M4 | Secrets manager, private database network, connection alerts, onboarding check | With staging (A4) and onboarding |
| B10 | Code-owner enforcement for security files | `CODEOWNERS` with the real team, and "Require review from Code Owners" on `main` | Prepared; needs A3 |
| B9 | External security review | Report, fixes and a retest letter | Needs A5. Test 3–4 weeks before pilot access |

## C. Meta, after verification

| # | Blocker | Evidence needed | Next action |
| --- | --- | --- | --- |
| C1 | Business verification result | Verified status | Wait after A2 |
| C2 | Tech Provider set-up, App Review, advanced access | Approved permissions | Screen recordings made on staging |
| C3 | Utility templates per pilot company | Approved templates | Drafts are ready in `pilot-synthetic-examples.md` |

## Order of work

- The longest chain is A1 → A2 → C1 → C2. It sets the earliest pilot date.
- **A3 unlocks the next step**: the first CI run on GitHub (B2) and code-owner enforcement (B10).
- A4 unlocks B3–B8.
- A5 unlocks B9.
- The other decisions can be made in parallel.

Pilot access needs every row closed, or explicitly accepted by you.
