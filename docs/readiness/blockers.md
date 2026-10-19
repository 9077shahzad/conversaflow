# Pilot readiness — consolidated blocker checklist

**Phase 1 status:** development complete; local checks reported passed; GitHub CI and hosted verification pending.
Live pilot approval remains pending those checks and the conditions below.

Updated 19 Oct 2026. "Owner" means Muhammad Shahzad; "Dev" means the development side (Claude). Nothing below has
been bought, submitted, sent, connected or deployed.

## A. Decisions and approvals (owner)

| # | Blocker | Owner | Evidence needed | Next action |
| --- | --- | --- | --- | --- |
| A1 | Contracting and Meta entity | Owner | Written confirmation that MERONATIC SOLUTIONS GROUP, LLC (Delaware) is the contracting and Meta entity; Certificate of Formation and EIN letter in hand | Confirm the entity and the document set listed in the prep pack (Meta section) |
| A2 | Meta business verification submission | Owner (Dev prepares) | Owner-approved document set; submission receipt from Meta | Review the pack: confirmed requirements, partner guidance and unresolved points are marked separately. Approve before anything is submitted |
| A3 | GitHub organisation and first push | Owner | Meronatic-owned organisation exists with 2FA required; private repo `conversaflow` created; push approved | Follow `docs/github-setup.md` (owner steps), then tell Dev to push |
| A4 | Hosting choice and spend | Owner | Approval of AWS Frankfurt (primary) or Scaleway (alternative) and a monthly budget | Review `hosting-comparison.md`; approve a Terraform *plan* for staging (shows resources and price, creates nothing) |
| A5 | Independent security review supplier | Owner | Approved shortlist and RFQ; signed NDA; supplier quote | Approve contacting Cure53, Doyensec and/or Cyphere with `security-review-rfq.md` |
| A6 | Annual pricing | Owner | Approved prices after reviewing margins | Review `ConversaFlow-Annual-Pricing-Margin.xlsx`. At growth scale annual margins are about 25% (Starter) to 56% (Enterprise); at pilot scale most plans run at a loss because fixed hosting is spread over five companies |
| A7 | Pilot companies and seat allowance | Owner | Named companies (one per sector) and agreement to a recorded 10-seat allowance each, since the 3-seat trial cap is below realistic team size | Confirm companies; invitations stay unsent until approved |
| A8 | Arabic wording reviewer | Owner | Named native Arabic business reader; returned workbook | Confirm the reviewer and send `ConversaFlow-Arabic-Review.xlsx` (101 strings, 9 screens) |
| A9 | Accept the remaining sign-in risk (ADR-027) | Owner | Written acceptance, or a decision to require MFA for every pilot user | Decide. The reviewer agrees the risk is accurately described, and added one Low item within it (R2-1: a holder of the sign-in database credential could lock a user out of MFA for an hour). Recommended: require MFA for all pilot users and keep that credential in a secrets manager |
| A10 | Legal documents | Owner (legal adviser) | Approved terms of service, privacy notice, data processing agreement, acceptable use policy | Instruct counsel; Dev can supply system and data-flow facts |

## B. Verification still to run (Dev, after the approvals above)

| # | Blocker | Owner | Evidence needed | Next action |
| --- | --- | --- | --- | --- |
| B1 | Independent recheck of the latest security fixes | Dev (independent reviewer) | Reviewer's post-fix verdict for the exact commit, item by item | **Done for `6972acb`:** N1–N4 verified closed, no new High or Medium findings (closure report). Later commits change documents and one build dependency only; the external review (B10) covers the final code |
| B2 | GitHub CI | Dev | Green CI run on GitHub for the pushed commit, logs kept | Runs on first push (needs A3) |
| B3 | Reproducibility from a clean checkout | Dev | Fresh clone, fresh database, migrations, isolation check and full tests run with the restricted roles; results saved in `docs/reports/evidence/` | Run immediately after A3 |
| B4 | Malware scanning in hosting | Dev | `freshclam` installs and updates official signatures; clamd runs with `TZ=UTC`; startup shows signatures *current*; uploads refused with signatures missing, outdated, scanner down or timed out | Needs A4. The refusal paths are already proven locally against a fake scanner; hosted validation stays open until official signatures are installed and updating |
| B5 | File-access revocation in hosting | Dev | Download link refused after the user is removed, the company access ends, or the link expires, through the real storage and CDN | Needs A4 |
| B6 | Storage permissions in hosting | Dev | Bucket is private; only the application role can read/write; direct object URLs refused; encryption on | Needs A4 |
| B7 | Session expiry in hosting | Dev | Sessions end after 60 minutes idle and 12 hours absolute, through the real load balancer and cookies | Needs A4 |
| B8 | Backup restoration | Dev | A timed restore of the staging database to a point in time, with a record of data loss and restore duration | Needs A4 |
| B9 | Content Security Policy nonces | Dev | Strict CSP without `unsafe-inline` for scripts, checked by browser tests | Development work, can start now |
| B10 | External security review | Supplier | Report, fixes and retest letter | Needs A5; test 3–4 weeks before pilot access |

## C. Meta, after verification (Phase 2 dependency)

| # | Blocker | Owner | Evidence needed | Next action |
| --- | --- | --- | --- | --- |
| C1 | Meta business verification result | Meta | Verified status in Business Manager | Wait after A2 |
| C2 | Tech Provider setup, App Review and advanced access | Owner + Dev | Approved permissions for WhatsApp Business management and messaging | Submit after C1, with a screen recording made on staging |
| C3 | Utility templates for the pilot | Pilot companies + Meta | Approved templates | Drafts are ready in `pilot-synthetic-examples.md`; submit per company once onboarded |

## Order of work

A1 → A2 → C1 → C2 is the longest chain and sets the earliest pilot date. A3 unlocks B2–B3; A4 unlocks B4–B8; A5
unlocks B10. A6–A10 can be decided in parallel. Pilot access needs every row closed, or explicitly accepted by the
owner.
