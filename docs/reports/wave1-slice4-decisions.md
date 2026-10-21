# Wave 1, slice 4 — owner decisions after packaging (21 Oct 2026, 12:24 Dubai time)

Recorded separately from the package. The package itself is unchanged: `w1s4-packaged` = `632272b`, code identical
to `w1s4-tested` = `ffdc5c7`.

## Status

- **Slice 4: packaged.** Local verification passed as reported (`clean-checkout-ffdc5c7.txt`: 449/449 API tests,
  15/15 browser checks, isolation check passed; final independent recheck of `ffdc5c7`: nothing at Medium or above).
- Local results use simulated WhatsApp and ClamAV's test signature only.
- **Pending:** GitHub CI, live-provider checks, hosted verification and pilot approval.
- **Not accepted:** G4 and the sign-in risk.

## Decisions

**P2-3: recipients over the limits at send time are skipped (approved).**
- A recipient who is over the frequency limits when their message is about to be sent is skipped. The message is not
  sent, and it is never sent to them automatically later. This is how `ffdc5c7` behaves.
- Any later campaign runs its own, fresh eligibility checks.
- The campaign report must show the skipped count and the reason. Today, skips at queue time already show their
  reason. Skips at send time show only as "not sent (stopped by our checks)", without the reason. This is recorded as
  backlog item **W1.14**, the first follow-up item.

## Findings kept open, with their limitations

| # | Severity | Limitation | Required before |
| --- | --- | --- | --- |
| B-2 | Low | Upgrade scenario reasoned from the code, not reproduced: a database that ran migrations 0032–0035 with campaign traffic could undercount the limits after upgrading to 0036. No such database exists today | **Must be tested and resolved before** any persistent database with campaign traffic is upgraded from a version between 0032 and 0035: reproduce it in an upgrade test, then correct the backfilled rows in a new migration or recreate the database |
| P2-2 | Low | The two end-to-end "several senders" tests pass without the lock; only the forced-overlap test proves the check is atomic | Keep the forced-overlap test in every run |
| N2 | Info | The sender's internal return value says "uncertain" in one late-answer case, although the stored and displayed status is "sent" | Nothing stored or shown is affected |

## GitHub

- **Push: pending.** The destination is pending. The standing requirement is a company-owned private repository;
  github.com/9077shahzad/conversaflow was selected in a multiple-choice question, not approved as a change to that
  requirement.
- GitHub is not linked to this workspace.
- **First CI run: pending** its own approval and the spending-control check.

## Domain (recorded 21 Oct 2026, 17:09 Dubai time)

- The owner bought **`conversaflow.io`** from GoDaddy for one year: registration $59.99, Full Domain Protection $12.99,
  **total $72.98**.
- The full record and the open points (registrant to match the contracting entity, auto-renew, DNS and email records,
  hosting) are in `docs/external-dependencies-and-costs.md`, section 6.
- The domain is not connected to anything yet. Hosting, DNS changes, deployment and other spending remain subject to
  their own approvals.
