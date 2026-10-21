# Wave 1, slice 3 — report (21 Oct 2026)

Branch `feature/brd-v1.2-wave1`. Candidate 3 (`rc3-tested` = `f1bc095`, `rc3-packaged` = `c3b6d3d`) is unchanged.

**Evidence baseline.** The slice 2 evidence stays tied to `4eda821` (`wave1-slice2-report.md`,
`clean-checkout-4eda821.txt`) and is not changed by this work. Everything below is later work, verified separately.

Scope, as instructed: the owner's retry decision, clearer wording on timeouts and duplicate prevention, then templates,
media, response-time targets (SLA timers) and the provider health and recovery screen, before campaigns.

## Commits after `4eda821`

| Commit | What | Evidence |
| --- | --- | --- |
| `8ebc94d` | Slice 2 report and evidence only (no code) | — |
| `571abe4` | Slice 3: migrations 0025–0029, retry decision, failure kinds, templates, media, SLA timers, channel health, two new guard rules, screens in English and Arabic | Clean checkout **failed** on one media test (`clean-checkout-571abe4.txt`, kept). Independently **reviewed**: 1 High, 3 Medium, 6 Low, notes |
| `cbc2f7f` | Media test made independent of other companies' download jobs (test only) | Clean checkout **passed** (`clean-checkout-cbc2f7f.txt`) |
| `0de62ee` | Review fixes 1–11, migration 0030, upgrade test; 0025 and 0026 corrected in place (see finding 1) | Clean checkout **passed** (`clean-checkout-0de62ee.txt`); targeted recheck: all eleven findings **verified**, nothing new at Medium or above; one Low leftover (below) |
| `dcece7b` | Recheck leftover: plain reason shown for "retries_exhausted:<code>" (web only) | Clean checkout **passed** (`clean-checkout-dcece7b.txt`) |

## Owner decisions implemented

**Retrying a colleague's failed message.** Anyone who may reply to the conversation right now may retry, including a
colleague's message. "May reply" means the same checks as a reply: the conversation is visible to them and not assigned
to someone else (a supervisor can take over as usual), replies are not paused, the customer has not opted out, the
24-hour window is open (or it is a template) and the channel is on. All of these are checked again by the worker at the
moment of sending, together with the sender's current permission: someone whose role has lost `inbox.reply`, or who has
left the company, cannot have a queued retry sent.

Both people are recorded on the retry copy (original author and person retrying), in the conversation history and in
the audit log, with the original message's status and failure kind.

**The retry limit cannot be bypassed.** The database itself works out each message's place in its retry chain from the
message being retried (`retry_root`, `retry_number`); a request cannot set them, and they cannot be changed afterwards.
The limit is one manual retry per original message across the whole chain, so a retry copy that fails cannot be
retried again. Two people pressing retry at the same moment produce one retry. Tested through the API and by writing to
the database directly.

**Uncertain deliveries keep the duplicate warning.** A colleague retrying an uncertain message must confirm that the
customer may receive it twice, exactly as the author would.

## Confirmed failure and uncertain delivery

These are now kept apart in the data, the code, the screen and the reports:

| | Meaning | How it is recorded | What a person can do |
| --- | --- | --- | --- |
| **Failed** (confirmed) | We know the customer did not receive it | `status = failed` with a required `failure_kind`: `blocked` (stopped by our checks before sending), `rejected` (WhatsApp refused it), `exhausted` (WhatsApp answered "not accepted" on all 5 attempts), `provider_reported` (accepted, then reported undelivered) | Retry directly |
| **Uncertain** | We do not know whether it arrived | `status = uncertain`, never a failure kind | Wait for WhatsApp's status update, or retry after confirming a possible duplicate |

A database constraint refuses a failed message without a kind and an uncertain one with a kind. The screen shows the
kind ("Not sent: WhatsApp refused it", "Not delivered: WhatsApp reported that delivery failed" …) and states
"Confirmed: the customer did not receive this message" only for failures; uncertain messages use a different colour and
wording.

## The 30-second timeout and duplicate prevention

The wording is now precise (sender.ts header and `architecture-extension.md`):

- The 30-second provider timeout **only limits how long we wait** for WhatsApp's answer. It does not stop WhatsApp from
  completing a request it already received, so a timeout always counts as **uncertain**, never as a failure.
- What prevents a second send when WhatsApp received the request but its answer is late or never arrives:
  1. WhatsApp is called only after the message moved from "queued" to "submitting" under a row lock and that change was
     saved. Any later attempt that finds "submitting" or "uncertain" does not call WhatsApp; it marks the message
     uncertain.
  2. Only WhatsApp's explicit "not accepted" answer (such as a rate limit) puts a message back in the queue. A timeout,
     a broken connection, a server error or anything unrecognised is uncertain.
  3. A late answer that arrives after we stopped waiting is discarded; WhatsApp's status update, which carries our
     message reference, settles the message without resending it.
  4. The timeout is well inside the 2-minute lease, so normally no second worker can take the job while the first is
     waiting. Duplicate prevention does not rely on this timing: a worker that stalls past its lease still cannot cause
     a second send (point 1).
  5. One send job per message (database constraint); a person's retry is a new message with its own job and the
     chain limit above.
- A request-level idempotency key on WhatsApp's send endpoint was **not verified in the sources checked** (21 Oct 2026),
  so the points above are the protection. The remaining duplicate risk is a person retrying an uncertain message, which
  needs explicit confirmation.

## What was built (local, sandbox provider only)

**Templates.** Each company's WhatsApp Business Account is recorded; one account can belong to only one company. Review
decisions, quality ratings and category changes arrive by webhook, routed to the company by the account id through one
reviewed lookup (the same narrow pattern as phone numbers). Only approved templates can be sent, outside or inside the
window; approval, account, opt-out and — for marketing templates — recorded marketing consent are checked again at send
time. A category change Meta announces in advance is shown but applied only when completed. "Check status with
WhatsApp" re-reads every template if a webhook was missed. Template bodies are checked against Meta's published review
rules before submission. Marketing consent is recorded by an agent with evidence; STOP withdraws it, and START does not
restore it.

**Media.** A customer's photo, voice note, video or document is recorded at once and downloaded in the background,
checked against Meta's published types and sizes and our storage limit, scanned for malware and stored in the company's
own folder. Staff see "Checking for viruses…" until the scan is clean; infected files are kept out and never linked.
No clear answer from the scanner means "try later", never "accept". Temporary download problems are retried with
back-off; after 5 attempts the file is marked "could not be downloaded". Agents can attach a stored, clean company file
to a reply; it is checked again just before sending.

**Response-time targets (SLA timers).** A first-reply or next-reply timer starts when a customer writes, counted in the
company's business hours and time zone (holidays skipped), or in calendar time if no hours are set. Only a reply that
WhatsApp accepted stops it; a blocked or failed reply does not, and an uncertain one counts once WhatsApp confirms it.
Met and missed targets are recorded with how late they were. The inbox shows "Reply due" and "Overdue".

**Channel health and recovery.** One page per company shows whether events are arriving, the sending queue (waiting,
delayed, stuck, given up), delivery problems split into uncertain and the four kinds of confirmed failure, customer
file downloads and template status, with a plain overall verdict. Recovery actions are limited to ones that cannot
message a customer twice: apply delivery updates that arrived early, download a customer's file again (within WhatsApp's
7-day limit), and re-read template status. Messages needing a person are listed with a link to their conversation;
retrying happens there, with all the usual checks. Viewing needs the new `channels.monitor` permission (owner, admin,
supervisor); acting needs `channels.manage` with two-step sign-in. Every action is audited.

**Screens (English and Arabic).** Template tab in the reply box (opens automatically when the window has closed, with
a preview), file attachments, media items with their scan status, failure kinds, retry lineage ("Sarah retried a message
written by Omar"), SLA line and badges, marketing consent; new Templates and Channel health pages.

## Results

### Local

Fresh clone, frozen lockfile, fresh PostgreSQL 16 / Redis 7 / ClamAV (test signature), restricted roles.

| Check | `0de62ee` (`clean-checkout-0de62ee.txt`) | `dcece7b` |
| --- | --- | --- |
| Secret scan, lint, type check, build | Passed | Passed |
| Dependency audit (strict, all packages) | No advisories | No advisories |
| Migrations | 0001–0030 | 0001–0030 |
| Isolation check (CI guard) | Passed | Passed |
| API tests | 403/403 in 25 files (including the upgrade test) | 403/403 in 25 files |
| Browser checks | 15/15 (Chromium; English and Arabic, three sizes, the new Templates and Channel health pages, template sending, media) | 15/15 |

The positive part of the guard test for note S2-N1 and the upgrade test need a disposable superuser; they run in the
local harness and will be skipped in GitHub CI unless one is provided there.

### GitHub CI

**Pending.** GitHub is not linked to this workspace. Before any push, the exact company-owned private repository and
the existing spending-control requirements must be confirmed with the owner (see "Before any push" below).

### Hosted

**Pending.** No hosting is approved for the backend or database.

### Pilot

**Pending.**

## Review findings

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | Migrations 0025 and 0026 failed on any database that already had data. The migration owner is subject to forced row security, so the backfills saw no rows and the new constraints then failed; one constraint was also added before its backfill | **High** | **Fixed and verified** (`0de62ee`): upgrade probe with two companies, authors, two-deep retry chains and connections migrated through 0030; row security forced on every table afterwards |
| 2 | One media test assumed it was the only company with download jobs (the cause of the failed clean checkout of `571abe4`) | Medium | **Fixed and verified** (`cbc2f7f`; clean checkout passed) |
| 3 | A provider call that timed out could overwrite a message that a status webhook had already settled during the call (for example "delivered" turned back into "uncertain") | Medium | **Fixed and verified**: the webhook's "delivered" stands when the call later times out; a late success after "read" leaves "read" |
| 4 | The guard's main row-security rule looked only at ordinary tables in schema public, so a company table in another schema, or a partitioned parent, was not checked | Medium | **Fixed and verified**: other schemas, partitioned parents, partitions attached later, foreign tables and inherited children are all flagged |
| 5 | Template updates arriving out of order could overwrite newer ones (e.g. an old approval undoing a pause; an old category change undoing a newer one) | Low | **Fixed and verified** (migration 0030): older updates are recorded as stale and ignored |
| 6 | Overlapping opening hours were counted twice in response targets | Low | **Fixed and verified**: refused in settings (touching intervals allowed), merged in the arithmetic |
| 7 | The response timer could stop even when the reply was not recorded as sent by that call | Low | **Fixed and verified** |
| 8 | Any constraint error during a retry was reported as "retry limit reached" | Low | **Fixed and verified**: only the chain-length constraint means "limit reached"; other cases say "can no longer be retried" |
| 9 | Arabic: some new send-time reasons showed as codes; channel health could show server English | Low | **Fixed and verified**; one leftover (raw code shown for "retries_exhausted:<code>") fixed in `dcece7b` |
| 10 | Channel health lists named customers from conversations a custom role could not otherwise open | Low/Info | **Fixed and verified**: the item lists follow the inbox visibility rule; counts stay company-wide |
| 11 | Template header and footer parameters were not validated; media is downloaded fully before the size check (real adapter must stream with a cap); `account_route` reveals whether an account id is connected (same as `channel_route`); accounts backfilled by 0026 get placeholder ids | Info | Header/footer parameters now refused. The others are recorded for the live adapter and onboarding |

**Finding 1 and migration checksums.** Migrations are checksummed, and the rule is to add a new migration rather than
change an applied one. 0025 and 0026 could not be fixed by a later migration, because they fail before any later one
runs. They had only ever been applied to disposable local databases (nothing has been pushed or hosted), so they were
corrected in place. Any local database that applied the earlier versions must be recreated. A new test migrates a
database at 0024 that already holds a company, an author, a conversation, failed, uncertain and retried messages and a
connection, through to the latest migration, and checks the backfills and that row security is forced again.

**Recheck notes (Info, no change made):** on data that 0024 allowed but the new rules do not (a retry of a retry), the
0025 backfill records both retries as first retries of their own parent rather than as one chain; this only makes the
limit stricter and such data exists nowhere. Template updates with the same timestamp (one-second resolution) are
applied in arrival order.

## Open items (none accepted)

| Identifier | What | Practical impact today | Recommended treatment | Status |
| --- | --- | --- | --- | --- |
| **G4** | A migration run by the database owner can still change roles, policies or functions in ways no static check fully covers | None while migrations are written and reviewed by us; the risk is a careless or hostile migration | Code-owner review of every migration on GitHub (needs the GitHub Team plan and setup), plus the CI guard | **Open; owner acceptance pending** |
| **Sign-in risk** | As recorded in the M1 closure report | Unchanged | Unchanged | **Open; owner acceptance pending** |
| **S2-N1** (slice 2 recheck note; "optional check") | Role-level or database-level defaults for the company-context settings (`app.*`) were not inspected by the guard | None found: neither the API role nor the migration owner can set these (PostgreSQL refuses both; tested), and the API sets the company context at the start of every transaction | Guard rule 7 now flags any such default, as defence in depth against a superuser-applied setting. Tested locally with a disposable superuser; that part of the test is skipped where no superuser is available (GitHub CI) | Treated in `571abe4`; rule verified by the reviewer |
| **S2-N2** (slice 2 recheck note; "database-review gap") | Company data copied into a new table without a `tenant_id` column (for example `CREATE TABLE … AS SELECT`) would not be treated as company data by the guard | A migration would be needed; the copy would sit outside company row security | Guard rule 8 now requires every table without `tenant_id`, in any schema, to be on a reviewed list of 25 shared tables. A column named `tenant_id` that does not hold the company is still not detectable by a static check; that part stays under G4 and code-owner review | Treated in `571abe4`; rule verified by the reviewer, including other schemas and foreign tables |
| **SR-1** | System roles of companies that already exist do not receive permissions added by later migrations (`inbox.pause`, `templates.manage`, `channels.monitor`) | None today: no real company exists; test and demo companies are created after all migrations | A reviewed, audited role-permission update for existing companies' built-in roles, run before the first pilot company and with every release that adds a permission | Open |
| **AX-3 (inbound)** | Inbound webhook events are still applied within the request | Safe for the sandbox (idempotent; Meta retries for up to 7 days) | Move applying to the worker before live traffic and before campaigns | Open (planned) |
| **Storage limit** | Our file limit (16 MB by default) is lower than Meta's 100 MB for documents | Larger customer documents are shown as "too large" and not downloaded | Raise with hosting, after storage costs are approved | Open |
| **Opt-in policy** | Utility and authentication templates require only that the customer has not opted out; marketing requires recorded consent | Meta's opt-in policy applies to business-initiated messages generally; each company remains responsible for its opt-ins | Show the opt-in duty in onboarding; record opt-in evidence during contact import (W1.7) | Open |
| **Send idempotency** | A request-level idempotency key on WhatsApp's send endpoint was not verified in the sources checked | None in the sandbox | Re-check Meta's messages reference before live sending | Open |
| **Informational** | Next.js "location is not defined" log during the deliberate bare-prefetch request in the security-headers test | None | As in the M1 closure report | Informational |

**Live WhatsApp remains blocked** until the legal entity is confirmed, Meta Tech Provider onboarding (Embedded Signup
v4) is approved, and number ownership is verified for each customer.

**Remaining Wave 1 work:** campaigns (next), contact import, tags and saved replies, automatic assignment, usage and
cost ledger, Click-to-WhatsApp ad reports.

## Before any push

The earlier push approval named `github.com/9077shahzad/conversaflow`, a personal account. The owner has since asked for
a **company-owned private repository**. Before any push: confirm the exact repository URL and owning organisation, that
it is private and empty, and the existing spending-control requirements (GitHub Team plan at the confirmed price, Actions
usage limited to the included allowance with over-budget usage blocked). Nothing has been pushed.

## Evidence kept separate

| Level | State |
| --- | --- |
| Local | Passed at `dcece7b` and `0de62ee` (403/403 API, 15/15 browser, guard passed). Slice 2 evidence unchanged at `4eda821` |
| GitHub CI | Pending (GitHub not linked; company-owned private repository to be confirmed) |
| Hosted | Pending (not approved) |
| Pilot | Pending |
