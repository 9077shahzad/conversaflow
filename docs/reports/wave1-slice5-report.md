# Wave 1, slice 5 — report (22 Oct 2026)

Branch `feature/brd-v1.2-wave1`. Candidate 3 (`rc3-tested` = `f1bc095`, `rc3-packaged` = `c3b6d3d`) and the slice 4
package (`w1s4-tested` = `ffdc5c7`, `w1s4-packaged` = `632272b`) are unchanged.

**What these results are.** Every result below is **local verification only**: WhatsApp is simulated (sandbox
provider), all data is demo data, and file scanning was verified only with the scanner's test signature. Current virus
definitions and hosted scanning remain unverified. Nothing here has run in GitHub CI or in a hosted environment.
Message-ID correlation (our reference returned in status updates; one WhatsApp id per accepted send) still needs
confirming against the real provider before live access.

Scope, as instructed on 22 Oct 2026: the campaign skip-reason display (W1.14), then contact import, tags, saved replies
and automatic assignment (W1.6, W1.7). Separately, a staging recommendation for the owner's decision (documents only).

## Commits after `eb9c5fd`

| Commit | What | Evidence |
| --- | --- | --- |
| `0522bb3` | W1.14: the campaign report shows recipients skipped at send time, with count and reason, separate from delivery results | Clean checkout **passed** (450/450 API, 15/15 browser) |
| `c4dab5a` | Staging recommendation (documents only; nothing bought or deployed) | — |
| `6b6b255` | Slice 5: migrations 0037–0039; contact import with opt-in evidence, tags, saved replies, automatic assignment; Contacts and Inbox setup pages in English and Arabic | Clean checkout **passed** (`clean-checkout-6b6b255.txt`: 479/479 API, 15/15 browser). Independently **reviewed**: 1 High, 5 Medium, 6 Low, Info |
| `add9cc9` | Review fixes H1, M1–M5, L1–L6 (migration 0040) | Clean checkout **passed** (`clean-checkout-add9cc9.txt`: 489/489 API, 15/15 browser). Independent recheck: all findings fixed except L5 (partly); three new Low (N1–N3), one Info (N4) |
| `0390c13` | Recheck fixes N1–N4 and the rest of L5 (migration 0041) | Clean checkout **passed** (`clean-checkout-0390c13.txt`: 494/494 API, 15/15 browser, migrations 0001–0041). Second recheck: N1–N4 and L5 **verified fixed at `0390c13`**; nothing above Info |

## 1. Skipped recipients in the campaign report (W1.14)

As decided on 21 Oct (P2-3): a recipient who fails a check just before sending is skipped, never sent later by the same
campaign. The report now shows "Skipped: n" with the reason for each group (opted out, no marketing consent, on the
suppression list, frequency limit, daily limit, no WhatsApp number), kept apart from sent, delivered, read and failed.
A later campaign runs its own checks from the start.

## 2. Contact import (W1.6)

- **Upload and preview.** A CSV (UTF-8, Arabic or English headers) is checked before anything is saved. The preview
  shows new contacts, updates, duplicates in the file, invalid numbers and the consent outcome for each row.
- **Phone numbers.** Validated with libphonenumber; Arabic and Persian digits accepted; `00` and `+` prefixes handled.
  A number without a country code is refused rather than guessed.
- **Consent.** A row marked as consenting gets marketing consent only with the evidence text the importer enters
  (source and date). A contact who has opted out, or who withdrew marketing consent, is **not** re-consented by an
  import; the preview and result count these separately.
- **Undo.** An import can be undone. Only contacts the import created, with no conversation, no other consent decision
  and no campaign record, are removed; the database enforces the same rule.
- **Permission.** `contacts.import` (owner and admin), and it requires two-step sign-in.

## 3. Tags and saved replies (W1.7)

- Tags per company, applied to conversations, with a tag filter in the inbox. Adding and removing a tag is recorded in
  the conversation's history; deleting a tag records its removal on each conversation.
- Saved replies in English and Arabic, inserted into the reply box; `{name}` is filled from the contact's name or
  dropped if there is none. The agent still reviews and sends.
- Managed by owner, admin and supervisor (`tags.manage`, `saved_replies.manage`).

## 4. Automatic assignment

- Off by default. When switched on, a new conversation (the first customer message in an unassigned conversation,
  including replies to a campaign) is given to the next agent in turn among the members chosen.
- Optionally only within business hours; the setting page warns if no business hours are set.
- Concurrent arrivals are serialised: one company-wide assignment lock, then the customer locks in a fixed order. This
  order is shared with the import commit so the two cannot deadlock.

## 5. Screens

New Contacts and Inbox setup pages; tag chips and filter and the saved-reply picker in the inbox. Checked in English and
Arabic at three sizes with the accessibility scan (Chromium only).

## 6. Independent review of `6b6b255` and fixes

| Finding | What it was | Fix |
| --- | --- | --- |
| H1 | A CSV within the 2 MB file limit was rejected by the default request size limit, so normal imports failed | A 5 MB request limit (the 2 MB file grows when sent as JSON) applies to the import route only |
| M1 | A webhook carrying several customers and an import commit could lock customers in different orders (deadlock) | One lock order everywhere: assignment lock, then customer numbers in ascending order; tested with 3,000 rows while deliveries arrive |
| M2 | An import could re-grant marketing consent to a contact who had withdrawn it | Withdrawn contacts are refused and counted separately |
| M3 | Undo could delete a contact with a later consent decision or campaign record (their history cascades) | Application check plus database trigger (migration 0040) |
| M4 | The contact list showed every contact to staff limited to their own conversations | Without `inbox.read_all`, only contacts with a conversation the person can see |
| M5 | Phone validation accepted impossible numbers | libphonenumber validation |
| L1–L6 | Search by number when the query has no digits; evidence asked when no consent was being granted; consent granted to someone opted out during the commit; unfinished quotes and duplicate columns in a CSV; old previews kept; wording ("Not opted out" instead of "Can be contacted") | All fixed |

Each fix has a regression test. All ten new tests **fail on `6b6b255`** and pass with the fixes.

Left as documented (Info, no change): the turn order restarts when a member leaves the list; a business-hours gap at
23:59; message deliveries are handled one at a time per company while assignment is on; a tag's usage count includes
conversations the viewer cannot see.

**Results at `add9cc9`:** clean checkout passed (489/489 API tests, 15/15 browser checks, migrations 0001–0040).

**Independent recheck of `add9cc9`** (a new reviewer, own copy of the code, given only the findings list). H1, M1–M5,
L1–L4 and L6 verified fixed. L5 only partly: old previews were cleared only when the same company previewed again. New:

| Finding | What it was | Fix |
| --- | --- | --- |
| N1 (Low) | The import's row lock on existing contacts was too strong and could deadlock with a campaign batch adding recipients for the same contacts (reproduced by the reviewer) | A lighter row lock that does not conflict with records being added for the contact |
| N2 (Low) | Undoing an import records a withdrawal; the M2 rule then treated it as the customer's own, so the corrected file could never be imported with consent | Withdrawals recorded by an undo are not counted as the customer's decision |
| N3 (Low) | Undo recognised the import's own consent record by its wording only; a colleague's note with the same wording could let undo delete the contact and that note | The record must also come from the import itself (application check and database trigger, migration 0041) |
| N4 (Info) | Undo racing a first message from the same customer failed as a whole and had to be retried | Undo takes the same per-number locks, in the same order, and waits instead |
| L5 (rest) | Old previews kept if the company never previewed again | The worker clears them hourly for every company through one reviewed lookup that sees only expired previews and can only empty their rows |

All five new tests **fail on `add9cc9`** and pass with the fixes.

Also noted by the reviewer, no change (Info): Mexican numbers in the old `+52 1` form are refused (WhatsApp reports
Mexican senders as `521…`, so an imported `52…` number would not match them; this existed before); an Italian number
written `+39 (0)6…` loses its significant 0; the H1 test sends about 260 KB rather than a full 2 MB file.

**Results at `0390c13`:** full run 494/494 API tests and 15/15 browser checks; clean checkout passed (`clean-checkout-0390c13.txt`).

**Second recheck of `0390c13`** (same reviewer, fresh copy). N1–N4 and L5 verified fixed. The reviewer checked the new
cross-company lookup against the live database: it can only empty the rows of previews already more than a day old,
returns only a count, and only the business role may call it. Two Info notes, left documented:
- The app decides a preview's expiry by its own clock and the worker by the database's. If the app clock runs a few
  seconds behind, a preview emptied by the worker in that moment could still be "imported" with no rows. Nothing is
  created or changed in that case, but the import would show as successful. Fix when convenient: check expiry in the
  database.
- Undo and a campaign starting at the same moment for the same newly imported contacts could block each other; one is
  stopped and can be repeated, and nothing is lost. This existed before these fixes.

## 7. Decision for the owner

**Analyst visibility (M4).** Analysts have `contacts.read` but not `inbox.read_all`. Under the fix they see only contacts
whose conversations they can see (in practice, unassigned ones). If analysts should see the full contact list, a
permission change is needed. Nothing is changed until you decide.

## 8. Still pending

- G4 (migrations run by the database owner) and the sign-in risk: open, **not accepted**.
- B-2, P2-2 and N2: documented. B-2 must be tested and resolved before any persistent-database upgrade with campaign
  traffic.
- Push: pending. The earlier requirement is a company-owned private repository; no later approval changes it, and
  GitHub is not linked to this workspace. Nothing has been pushed.
- First GitHub CI run: pending its own approval and spending-control check.
- Staging: recommendation prepared (`docs/readiness/staging-recommendation.md`); purchase and deployment pending
  approval.
- Message-ID correlation, template review, delivery statuses and current virus definitions: need live or hosted checks.
