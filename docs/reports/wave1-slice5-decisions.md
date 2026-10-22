# Wave 1, slice 5 — owner decisions (22 Oct 2026, 20:05 Riyadh time)

Recorded separately from the slice 5 report. The code is unchanged by this record.

## Status

- **Slice 5: locally verified, as reported.**
  - Tested code: `0390c13` (`clean-checkout-0390c13.txt`: 494/494 API tests, 15/15 browser checks, migrations
    0001–0041, isolation check passed).
  - Documentation commit: `1904028` (report, acceptance matrix and evidence only; no code difference from `0390c13`).
  - Independently reviewed (`6b6b255`) and rechecked twice (`add9cc9`, `0390c13`). At `0390c13`, nothing above Info.
- Local results use simulated WhatsApp, demo data and the scanner's test signature only. Current virus definitions
  and hosted scanning remain unverified.
- **Recorded separately, all pending:** GitHub CI (push to the company-owned private repository and the first CI run
  each need their own approval), hosted verification (no hosting approved), pilot access (not approved).
- **Not accepted:** G4 and the sign-in risk.

## Decisions

**Analysts' contact visibility stays restricted (review finding M4).**
- People without `inbox.read_all` (for example analysts) see a contact only if they may open one of that contact's
  conversations. They do not get the full contact list.
- This is how `0390c13` behaves. No permission change is to be made.
- A contact with no conversation (for example one just imported) is visible only to people with `inbox.read_all`.
