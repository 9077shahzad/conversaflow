# Wave 1, slice 4 — report (21 Oct 2026)

Branch `feature/brd-v1.2-wave1`. Candidate 3 (`rc3-tested` = `f1bc095`, `rc3-packaged` = `c3b6d3d`) is unchanged.

**Evidence baseline.** The slice 2 evidence stays tied to `4eda821` and the slice 3 evidence to `0de62ee` and
`dcece7b`. Nothing in those reports or evidence files is changed by this work. Everything below is later work, verified
separately, and each result names the commit it was tested at.

Scope, as instructed on 21 Oct 2026: four corrections first (SR-1 permissions, late provider answers, failure wording,
sandbox labels), the 16 MB limit kept and shown, then campaigns.

## Commits after `2741eca`

| Commit | What | Evidence |
| --- | --- | --- |
| `264379b` | Slice 4: migrations 0031–0033, SR-1 upgrade, late answers and exact matching, attempt evidence, retry eligibility by message type, sandbox and scanner labels, 16 MB limit shown, campaigns and suppression list, screens in English and Arabic | Clean checkout **passed** (`clean-checkout-264379b.txt`). Independently **reviewed**: 1 High, 3 Medium, 2 Low, Info |
| `294a79d` | Review fixes S4-1 to S4-7 | Clean checkout **passed** (`clean-checkout-294a79d.txt`). Targeted recheck: all findings **verified fixed**; one new Medium (N1) |
| `074644f` | Recheck N1 fix | Clean checkout **passed** (`clean-checkout-074644f.txt`) |
| (this report) | Report, acceptance matrix and evidence files only (no code) | — |

## 1. SR-1: permissions for companies that already exist

**The problem.** Built-in roles (owner, admin, supervisor, agent) are copied into each company when it is created.
Permissions added by later migrations reached new companies but not existing ones.

**The fix (migration 0031).** A reviewed reference table, `system_role_grants`, lists every permission added to a
built-in role after the first release, with the migration that added it:

| Role | Added permissions |
| --- | --- |
| owner, admin | `inbox.assign`, `channels.manage` (0022), `inbox.pause` (0024), `templates.manage` (0026), `channels.monitor` (0029), `campaigns.manage` (0033) |
| supervisor | `inbox.assign`, `inbox.pause`, `templates.manage`, `channels.monitor` |
| agent | none |

The migration adds these rows to the matching built-in role of every existing company and nothing else. It adds only
missing rows (it never removes or changes a permission), touches only roles marked as built-in, and leaves custom roles
alone. Any future migration that adds a permission to a built-in role adds its own rows to this table and runs the same
update (0033 does this for `campaigns.manage`).

**Tests.**
- Fresh installation: a new company gets exactly the defined permissions on each built-in role.
- The upgrade list is checked against history: the permissions each built-in role has now, less those it had in the
  first release (read from migration 0003), must equal the list. A permission added without a list entry fails the test.
- Upgrade: a database migrated to 0021 with a company, its built-in roles and two custom roles (`qa`, `night_shift`) is
  migrated to the latest version. Built-in roles gain exactly the listed permissions; the custom roles are unchanged.

## 2. Late answers from WhatsApp

**Before:** after the 30-second wait, a late answer was discarded and the message stayed "uncertain" until a status
update arrived.

**Now:**
- After the 30-second wait the message is recorded as uncertain at once, but the request is kept open for a further
  60 seconds. If WhatsApp answers in that time, its message id is stored and the message becomes "sent".
- The late answer never lowers a status. If a status update already said "delivered" or "read", that status stays and
  only the id is added.
- Nothing is sent again in any case. If no answer comes in the extra 60 seconds, the request is cancelled and the
  message stays uncertain.
- An id already held by another message is refused, so one WhatsApp id can never point to two of our messages.

**How a later status update finds the exact message.** Each send carries our own message id to WhatsApp
(`biz_opaque_callback_data`), and WhatsApp returns it in status updates.
- If we hold WhatsApp's id, the update is matched on that id.
- If we never received WhatsApp's id (the uncertain case), the update is matched on our own message id. This is used
  only while we hold no WhatsApp id for the message, and the WhatsApp id from the update is stored then.
- Matching never uses the customer, the conversation or the time.

The test sends three messages to the same customer, makes all three uncertain, and sends status updates in a different
order. Each update settles its own message only.

## 3. Failure wording based on evidence

Each send attempt is now recorded in an append-only table (`send_attempts`) with its outcome: accepted, not accepted
(an explicit refusal such as a rate limit), rejected, uncertain (no answer or an unclear one), interrupted (the worker
stopped mid-attempt) or late accepted.

- **"Not sent: WhatsApp declined it on each of 5 attempts"** (`exhausted`) is used only when there are at least five
  recorded "not accepted" answers and no other kind of outcome for that message.
- If any attempt had no answer or an unclear answer, before or after the refusals, the message stays **uncertain** with
  the reason "mixed attempt outcomes". It is never reported as a confirmed failure.
- The conversation shows the attempt log for failed and uncertain messages.

**Retry eligibility now depends on the message type.**
- A failed ordinary reply cannot be retried once the 24-hour window has closed. The reason is shown.
- A failed approved template can still be retried outside the window, subject to the usual checks: template still
  approved, marketing consent for marketing templates, no opt-out, replies not paused, not assigned to someone else, not
  already retried.
- The server returns the reason with each message and the screen shows it, so the button is not offered where the
  worker would refuse.

## 4. Sandbox and scanner labels

The screens no longer imply that simulated results were checked against live services.

| Item | What the local system does | Label shown |
| --- | --- | --- |
| Template review | Simulated by the sandbox provider; nothing is submitted to Meta | Status marked "simulated review"; note "Sandbox: review decisions shown here are simulated, not decisions made by WhatsApp." |
| Provider acceptance and delivery | Simulated by the sandbox provider | Status followed by "(simulated)"; conversation banner "Sandbox: sending, WhatsApp's acceptance and delivery updates in this conversation are simulated. Nothing reaches WhatsApp." |
| Malware scan | ClamAV with a test signature locally; a test scanner in some unit tests | Each file records how it was scanned: `official_current` (only if ClamAV reports current official definitions), `unverified_signatures` or `test_double`, with the signature version and time. Shown as, for example, "Malware scanning here uses test signatures only, not current virus definitions." |

A new endpoint, `GET /v1/me/environment`, tells the screens whether WhatsApp is simulated or live, the scanner's basis
and signature version, and the file size limit. Channel health and Templates show the same notes.

**None of the results in this report were verified against live WhatsApp or current virus signatures.**

## 5. The 16 MB limit

Kept for now, as instructed.
- **Shown:** in the reply box ("Up to 16 MB per file."), when a chosen file is too big ("This file is larger than 16 MB,
  the current limit."), and on customer files refused for size ("larger than allowed for its type (WhatsApp's limit for that type, or our 16 MB
  limit if lower)"; WhatsApp's own limits are lower for images and stickers).
- **Enforced:** the browser checks the size before upload; the server refuses larger uploads; customer files over the
  limit are not downloaded and are shown as too large. All three use the same setting (`MAX_UPLOAD_BYTES`, default
  16 MB); the screens read it from the environment endpoint.
- **Later enhancement:** larger documents (Meta allows up to 100 MB), recorded as backlog item W1.13, after storage
  costs and hosting are approved.

## 6. Migration edits to 0025 and 0026

Recorded in `docs/reports/evidence/migration-edit-check.txt`:
- Files changed in place: `0025_retry_lineage_failure_kinds.sql` and `0026_templates.sql` (first version in
  `571abe4`, corrected in `0de62ee`).
- Check run on 21 Oct 2026: no hosted database exists; the screens preview was never published and has no database; no
  git remote is configured; Docker is not running; the system PostgreSQL cluster holds only its default databases; no
  leftover local test clusters.
- Conclusion: no persistent environment applied the earlier versions. Any other database that did must be recreated.
  The migration runner refuses changed files by checksum, so this cannot happen silently.
- The populated-database upgrade test from slice 3 is kept and extended: it now migrates through 0033.

## 7. Campaigns

A campaign sends one approved template to contacts who have recorded consent. Everything below is local, with the
sandbox provider only.

| Requirement | How it works |
| --- | --- |
| Audience preview | Before creating, the screen shows how many contacts are eligible, the count for each exclusion reason (opted out, no marketing consent, suppressed, frequency limit, no WhatsApp number), sample messages with the contact's name filled in, and the daily limit |
| Recorded consent | Marketing templates go only to contacts with recorded marketing consent (with evidence and who recorded it). STOP withdraws it; START does not restore it |
| Suppression list | Numbers that must never receive campaigns, whatever their consent says. Add, edit reason and remove; every change is audited |
| Scheduling | Send now or at a set time. Recipients are chosen when the campaign starts, not when it is scheduled |
| Frequency limits | Company settings: at most 2 campaign messages per contact in 7 days, at least 24 hours apart, at most 250 new campaign messages per number per day (Meta's starting limit, read 20 Oct 2026). A company can lower these |
| Cost estimate | Uses only verified Meta rates for each market. If any market in the audience has no verified rate, no total is shown and the screen says so; it never guesses. Marketing rates for Saudi Arabia and the UAE are **not verified** in the sources checked, so the estimate for the demo audience is shown as unavailable |
| Pause, resume and cancel | Pausing holds queued messages and queues no more; resuming continues without sending anything twice; cancelling stops everything not yet sent |
| Permission | `campaigns.manage`, with two-step sign-in; given to owner and admin through the SR-1 list |

**Checks before each send.** Each recipient is checked when their message is queued, and again by the sender just
before it leaves:

| Check | When queued | Just before sending |
| --- | --- | --- |
| Opt-out, including one received after scheduling or after queueing | Yes | Yes |
| Marketing consent still recorded | Yes | Yes |
| Not on the suppression list | Yes | Yes |
| Template still approved (and for this number's account) | Yes | Yes |
| Campaign still running; its creator still holds `campaigns.manage` | Yes | Yes |
| Replies not paused for the conversation | — | Yes |
| Frequency limits and the number's daily limit | Yes | No (counted when queued) |

A paused or scheduled campaign holds the message without counting an attempt. A cancelled campaign blocks it. A
campaign message cannot be retried from the inbox, because a retry would be an ordinary message and would skip these
checks.

**No duplicate sending.**
- One recipient row per contact per campaign (database constraint).
- Each recipient's message uses the recipient id as its idempotency key, so a second attempt to queue it is refused.
- The recipient update and the message are written in one transaction, so a crash leaves both or neither.
- Campaigns are picked up by the worker through one reviewed lookup with a lease, and one company's batches run one at
  a time, so two workers do not run batches together. If the lease expires, the constraints above still prevent a
  second message.
- A campaign is completed only when nobody is left to queue and none of its messages is still waiting, so it can be
  paused or cancelled until then.

**Tests (19, in `campaigns.test.ts`; 13 first, 6 added after the review and recheck).**
- Permission and two-step sign-in; other companies cannot see campaigns.
- Preview counts, exclusion reasons, samples, and no cost guess.
- An opt-out after scheduling is respected at queue time and at send time.
- An opt-out after queueing stops the message at send time.
- A suppression added after queueing stops the message.
- Duplicate jobs: two runners at once queue each recipient once; a direct duplicate insert is refused by the database.
- Recovery: a crash in the middle of a batch queues nothing; the next run queues everyone exactly once.
- Partial failure: one refused send does not stop the others; nothing is resent on later runs.
- Frequency limit across campaigns.
- A scheduled campaign does not start early.
- A template paused by WhatsApp after scheduling stops the sends.
- Pause, resume and cancel.
- Suppression list management and audit.
- After the review: no inbox retry of a campaign message; cancel still possible after everyone is queued; completion
  after the messages leave; resume of a campaign paused before it started; two campaigns batched at once stay within
  the daily and frequency limits; a waiting campaign keeps its lease instead of being picked up again at once.

**Screens.** A Campaigns page in English and Arabic: list with status and counts, the create form with the audience
preview, scheduling, and pause, resume and cancel. Without two-step sign-in, the page explains that campaigns need it
and does not show the form. The demo data includes one completed campaign and one draft.

**Guard.** `campaigns` and `campaign_recipients` are company tables under forced row security. The worker's lookup
(`campaign_claim`) is owned by `cf_dispatch`, which can see only the scheduling columns of running and scheduled
campaigns; its definition is pinned in the guard. `system_role_grants` is on the reviewed list of shared tables.

## Results

### Local

Fresh clone, frozen lockfile, fresh PostgreSQL 16 / Redis 7 / ClamAV (test signature), restricted roles. Evidence files
are in `docs/reports/evidence/`, one per commit.

| Check | `264379b` | `294a79d` | `074644f` |
| --- | --- | --- | --- |
| Secret scan, lint, type check, build | Passed | Passed | Passed |
| Dependency audit (strict, all packages) | No advisories | No advisories | No advisories |
| Migrations | 0001–0033 | 0001–0033 | 0001–0033 |
| Isolation check (CI guard) | Passed | Passed | Passed |
| API tests | 429/429 in 28 files | 435/435 in 28 files | 436/436 in 28 files |
| Browser checks (Chromium; English and Arabic, three sizes) | 15/15 | 15/15 | 15/15 |

The six regression tests for S4-1 to S4-5 were also run against the unfixed `264379b`, and all six failed there as
expected.

These results come from the sandbox provider and ClamAV's test signature only. None of them is a check against live
WhatsApp, Meta's template review or current virus definitions.

The upgrade tests (from 0021 for SR-1, and the populated-database test from slice 3, now through 0033) need a
disposable superuser. They run in the local harness, and will be skipped in GitHub CI unless one is provided there.

`clean-checkout-294a79d.txt` was committed part-written with `074644f`, because that run was still writing it. The
complete file is committed with this report.

### GitHub CI

**Pending.** GitHub is not linked to this workspace. Nothing has been pushed.

### Hosted

**Pending.** No hosting is approved for the backend or database.

### Pilot

**Pending.**

## Review findings

An independent reviewer worked on a separate clone of `264379b`, without seeing the work being produced, and proved
each finding below with a probe test. Fixed in `294a79d`. S4-1 to S4-5 each have a regression test. All six new tests were run against the unfixed `264379b`
and failed there, and they pass with the fixes.

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| S4-1 | A failed campaign message (for example, stopped because the number was added to the suppression list) could be retried from the inbox. The retry was an ordinary template message, so it skipped the suppression list, a cancelled campaign, the creator's permission and the frequency limits, and was sent | **High** | **Fixed** (`294a79d`): campaign messages cannot be retried individually (server refuses; button not offered, with the reason shown) |
| S4-2 | As soon as every recipient was queued, the campaign was marked completed and could no longer be paused or cancelled, though queued messages could still be waiting to leave | Medium | **Fixed**: completed only when none of its messages is still waiting |
| S4-3 | A scheduled campaign that was paused and then resumed completed with nothing sent | Medium | **Fixed**: resumes as scheduled if it had not started |
| S4-4 | Two workers batching different campaigns at the same moment could together exceed the number's daily limit and message one contact inside the frequency limits (needs more than one worker; today there is one) | Medium | **Fixed**: one batch at a time per company |
| S4-5 | A late answer saved before the timeout outcome left the message "uncertain" although WhatsApp's acceptance was recorded. The id was kept and nothing was resent, so the requirement held, but the inbox kept offering a retry with a duplicate warning | Low | **Fixed**: the message becomes "sent" in either order. Attempt times now use the actual clock time |
| S4-6 | Wording: the campaign introduction said the contact frequency is checked just before sending (it is checked when queued); the "too large" label for customer files named 16 MB, though images and stickers have lower WhatsApp limits | Low | **Fixed** in English and Arabic |
| S4-7 | Info: any API session can call the campaign lookup and so extend other companies' campaign leases (no data exposed, and no code does this); the daily limit counts campaign messages per number, whereas Meta counts unique customers per business portfolio; the "days needed" estimate ignores what was already used today; files refused on arrival show no scan basis because they were never scanned; messages marked "exhausted" before 0032 have no attempt records | Info | Recorded. The lookup and daily-limit points are for the live adapter and the next review of the lookup |

**Recheck of `294a79d`.** The same reviewer re-ran its probes against the fixes and verified S4-1 to S4-6 fixed (S4-7
partly: attempt times corrected; the other Info points recorded above). It found no deadlock between the company
batch lock, the campaign row lock and the sender's share lock (six rounds of concurrent batches, sends and
pause/resume: 8 messages, 8 unique, 8 sent), and no way for a campaign to wait forever on a message with a dead job.
One new finding:

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| N1 | A running campaign that was waiting (for room under the daily limit, or for its queued messages to leave) could be picked up again at once, so the worker's loop kept running batches and never paused between polls, competing for the same locks | Medium | **Fixed** (`074644f`): a batch that changed nothing keeps its lease for 30 seconds; any progress releases it as before. Test added |
| N2 | The sender's return value for the late-answer case still says "uncertain" although the stored message is "sent" | Info | Recorded; only the internal return value, not what is stored or shown |

The reviewer also confirmed as met: the SR-1 upgrade (only listed permissions, only built-in roles, custom roles
untouched, both paths tested), late-answer reconciliation and exact matching, the evidence rule for "declined on each of
5 attempts", retry eligibility for replies and templates, the sandbox and scanner labels, the 16 MB limit on all three
paths, the cost estimate using verified rates only, the send-time checks, and row security on the new tables with the
lookup pinned by the guard.

## Open items (none accepted)

| Identifier | What | Status |
| --- | --- | --- |
| **G4** | A migration run by the database owner can still change roles, policies or functions in ways no static check fully covers | **Open; owner acceptance pending** |
| **Sign-in risk** | As recorded in the M1 closure report | **Open; owner acceptance pending** |
| **SR-1** | Existing companies' built-in roles did not receive later permissions | **Treated** in this slice (migration 0031 and tests). Run with every release that adds a permission |
| **AX-3 (inbound)** | Inbound webhook events are still applied within the request | Open. Should move to the worker before live traffic and before live campaigns |
| **Campaign rates** | Marketing rates for Saudi Arabia and the UAE are not verified in the sources checked | Open. No cost total is shown until Meta's current rate card is checked and recorded with its date |
| **Messaging tier** | The daily limit default (250) is Meta's starting tier. The real tier of each number is not read from Meta yet | Open, for the live adapter |
| **Storage limit** | 16 MB kept; larger documents are a later enhancement (W1.13) | Open (planned) |
| **Send idempotency** | A request-level idempotency key on WhatsApp's send endpoint was not verified in the sources checked | Open. Re-check before live sending |

**Live WhatsApp remains blocked** until the legal entity is confirmed, Meta Tech Provider onboarding is approved, and
number ownership is verified for each customer.

**Remaining Wave 1 work:** contact import (with opt-in evidence), tags and saved replies, automatic assignment, usage
and cost ledger, Click-to-WhatsApp ad reports.

## Approvals still pending

- **G4 and the sign-in risk:** open. Neither is recorded as accepted.
- **GitHub:** before any push, confirm the exact company-owned private repository and the existing spending-control
  requirements. The GitHub Team purchase is kept separate from the import and the first CI run. The previously agreed
  spending-control options stand. No paid upgrade has been approved, and none was made.
- **GitHub CI, hosted verification and pilot access:** pending their approvals.

## Evidence kept separate

| Level | State |
| --- | --- |
| Local | Passed at `264379b`, `294a79d` and `074644f` (latest: 436/436 API, 15/15 browser, guard passed). Earlier evidence unchanged at `4eda821`, `0de62ee` and `dcece7b` |
| GitHub CI | Pending |
| Hosted | Pending |
| Pilot | Pending |
