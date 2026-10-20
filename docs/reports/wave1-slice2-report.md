# Wave 1, slice 2 — report (20 Oct 2026)

Branch `feature/brd-v1.2-wave1`, continuing from `9a5aa2e`. Candidate 3 (`rc3-tested` = `f1bc095`,
`rc3-packaged` = `c3b6d3d`) is unchanged.

Scope, as instructed: the English/Arabic inbox, then reliable background sending, with the owner's three decisions
(reply pause, prominent failed replies with safe retry, STOP followed by punctuation or emoji), a stronger isolation
guard, and verified number ownership before any live connection.

## Commits

| Commit | What | Evidence |
| --- | --- | --- |
| `138869e` | Slice 2: migration 0024, inbox screen (EN/AR), send queue and worker, reply pause, failed-reply flag and retry, opt-out normalisation, ownership gate, guard allowlist | Clean checkout **passed** (`clean-checkout-138869e.txt`: 330/330 API, 14/14 browser). Independently **reviewed**: no Critical, High or Medium; 3 Low, 4 notes |
| `e3c49dc` | Review fixes (S1–S3 and notes); planning-document updates | Clean checkout **passed** (`clean-checkout-e3c49dc.txt`); targeted recheck: S1, S2a, S2b, S3 and both notes **verified**; one new Low route found (S2c) |
| `1c3854c` | Guard rule 5 (S2c) and zero-width word gaps in opt-out commands | Clean checkout **passed** (`clean-checkout-1c3854c.txt`); recheck: rule 5 and the keyword change **verified**; one further Low route found (S2d) |
| `4eda821` | Guard rule 6 (S2d): functions and operators used by policies pinned; fixed search path | Clean checkout **passed** (`clean-checkout-4eda821.txt`); recheck: S2d **verified** (replacement, owner change, setting change, schema shadow, helper function, custom operator all flagged); nothing new at Medium or above |

## What was built

**Inbox screen (English and Arabic, right-to-left).** Conversation list with filters (mine, unassigned, all, needs
attention, paused) and badges; conversation view with claim, hand back, assign, pause and release; delivery ticks;
composer with reply and internal-note tabs. Refusals are shown in the reader's language. Checked at phone, tablet and
desktop sizes in both languages.

**Reply pause (decision 1).** A person with the new `inbox.pause` permission (owner, admin, supervisor) can pause
replies on a conversation with a reason (3–300 characters) and an expiry (5 minutes to 7 days) or until released.
While paused, everyone except the person who paused it is refused — enforced in the API and again by the worker just
before sending, so messages already queued are also held back. The reason, who paused it and when it ends are shown
to the team. Pausing and releasing are recorded in the conversation history and the audit log. Internal notes never
block replies.

**Failed replies (decision 2).** A failed reply shows a prominent banner with the provider's reason. Retry creates a
new, linked message (at most one retry per original). Where delivery is **uncertain** — the provider may have
received it but did not confirm — nothing is retried automatically, and a manual retry needs an explicit
"this may send a duplicate" confirmation. Retry is hidden when the conversation is blocked (opted out, paused, window
closed) or assigned to someone else.

**Opt-out commands (decision 3).** A standalone STOP followed by punctuation or emoji ("STOP!!", "stop 🛑", "Stop.")
is an opt-out, as are the Arabic equivalents (إيقاف، أوقف، توقف، إلغاء الاشتراك، وقف الرسائل) with or without
diacritics, tatweel or alef variants. Text is normalised (Unicode NFKC, invisible format characters removed, case
folded, emoji and punctuation removed) before an exact match. "stop" inside a sentence ("please don't stop the
service") does not match; nor does a lone إلغاء ("cancel"), which customers use about bookings. 43 cases are tested (27 opt-out, 5 opt-in, 11 ordinary messages), plus one
end-to-end case through a signed webhook.

**Reliable sending.** Each reply becomes a queued message plus a job. The worker leases jobs (`FOR UPDATE SKIP
LOCKED`), re-checks every rule, records the message as "submitting" and commits **before** calling the provider, then
records the outcome:

| Outcome | What happens |
| --- | --- |
| Accepted | Sent; any status that arrived early is applied |
| Refused by the provider | Failed, with the provider's reason; no automatic retry |
| Not accepted (temporary error) | Back to the queue with back-off (5 s, 10 s, 20 s, …); failed after 5 attempts |
| Uncertain (timeout, connection lost after sending) | Marked uncertain; **never retried automatically** |
| Worker crashed mid-call | The next worker finds "submitting" and marks it uncertain, not queued |

The provider call has a 30-second timeout, well inside the 2-minute lease, so a slow call cannot outlive the lease and
be sent twice. Each message carries its own reference to the provider, which WhatsApp echoes back in status updates,
so a message that was delivered but never confirmed can still be matched.

Worker tests cover, as instructed: crash before provider submission, crash after submission, duplicate jobs and
concurrent workers, uncertain delivery (including delivered-but-unconfirmed, later matched by reference), temporary
errors and exhaustion, stuck "submitting" messages, expired leases, and the slow-call case.

**Verified number ownership.** A live WhatsApp connection cannot exist without ownership proof
(`ownership_verified_at` and method `embedded_signup_v4`), enforced by a database constraint; the application role
cannot write those columns at all. Only the sandbox connection works today.

**Isolation guard (CI).** The guard now checks:
1. only listed roles may read company tables, each only its listed tables;
2. every privileged function a login role can run must be on a reviewed list **and match its reviewed definition and
   owner** (pinned by hash);
3. policies on company tables may only target the application role or listed readers;
4. no views over company tables;
5. every permissive policy the application role is subject to must be the standard company rule or a reviewed
   exception pinned by hash (added after the recheck, S2c);
6. functions used inside policies (`app_tenant_id()`, `app_user_id()`) are pinned by hash, operators must be
   built in, and the guard runs with a fixed search path (S2d).

The two bypasses the reviewer demonstrated (an owner-level policy plus a view; replacing the body of a reviewed
function) are tested and now fail the guard.

## Results at `4eda821` (branch tip)

### Local (clean checkout)

Fresh clone, frozen lockfile, fresh PostgreSQL 16 / Redis 7 / ClamAV (test signature), restricted roles
(`clean-checkout-4eda821.txt`). The same checks also passed at `1c3854c` (350 API tests), `e3c49dc` (341) and
`138869e` (330).

| Check | Result |
| --- | --- |
| Secret scan, lint, type check, build | Passed |
| Dependency audit (strict, all packages) | No advisories |
| Migrations | 0001–0024 |
| Isolation check (CI guard) | Passed |
| API tests | 351/351 in 19 files |
| Browser checks | 14/14 (Chromium; English and Arabic, three sizes, security policy) |

### GitHub CI

**Pending.** GitHub is not yet linked to this workspace. The approved push target is
`github.com/9077shahzad/conversaflow`; the repository URL, owner, privacy and emptiness will be confirmed before the
push.

### Hosted

**Pending.** No hosting is approved for the backend or database. The free Netlify screens preview (configuration
`1eac98c`) is waiting on the same GitHub link and does not include this branch.

### Pilot

**Pending.**

## Review findings

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| S1 | Invisible format characters (e.g. right-to-left marks) next to "STOP" defeated the match; أوقف missing | Low | **Fixed and verified** (`e3c49dc`). Follow-up note (a zero-width character used as a word gap, "stop", zero-width space, "all") fixed in `1c3854c` |
| S2 | Guard could be bypassed by an owner-level policy plus a view, or by replacing a reviewed function's body | Low | **Fixed and verified** (`e3c49dc`): both bypasses now fail the guard |
| S3 | A provider call slower than the lease could let a second worker send the same message | Low | **Fixed and verified** (`e3c49dc`): one provider call, final status uncertain, the second worker finds nothing to do |
| Note | Worker should require a live lease explicitly | Info | **Fixed and verified** |
| Note | Retry was shown when the conversation was assigned to someone else | Info | **Fixed and verified** |
| S2c | A second, looser policy for the business role (e.g. `USING (true)`) was not flagged; PostgreSQL combines such policies with OR, so it would cancel company isolation. Needs a migration | Low | **Fixed and verified** (`1c3854c`, guard rule 5) |
| S2d | Replacing the function every company policy calls (`app_tenant_id()`) changed what the policies mean without changing their text, and was not flagged. Needs a migration | Low | **Fixed and verified** (`4eda821`, guard rule 6) |
| Note | The guard does not inspect per-role or per-database setting defaults (`app.*`). Not reachable today: neither the API role nor the migration owner can set them, and the API sets the company context at the start of every transaction | Info | Open — optional hardening |
| Note | A migration could copy company data into a table without a `tenant_id` column (the guard identifies company tables by that column) | Info | Open — relies on code-owner review of migrations (pending GitHub) |
| Note | Anyone allowed to reply can retry a colleague's failed message | Info | Open — believed intended (the retry is recorded with who did it); for the owner to confirm |
| Note | The API role can lease any company's send jobs through `dispatch_claim` (it sees only job ids; the work itself runs under company isolation) | Info | Open — documented; to be narrowed when the worker gets its own login role |

## Open items (none accepted)

- **Remaining Low guard finding — open.** The guard now catches every bypass identified across four review rounds
  (S2a–S2d), each with a test, but a migration run by the
  database owner can still change roles, policies or functions in ways no static check fully covers. This is the
  documented residual risk **G4**. Its owner acceptance is **pending**; it has not been recorded as accepted. Code-owner
  review on GitHub is the intended backstop and is itself pending (GitHub Team purchase and setup).
- **Sign-in risk acceptance — pending**, as before.
- **Live WhatsApp — blocked** until the legal entity is confirmed, Meta Tech Provider onboarding (Embedded Signup v4)
  is approved, and number ownership is verified for each customer.
- **Informational:** a Next.js "location is not defined" log line during the deliberate bare-prefetch request in the
  security-headers test (pre-existing, listed in the M1 closure report).
- **Remaining Wave 1 work:** templates (and sending outside the 24-hour window), media messages, campaigns, SLA timers,
  and a provider health and webhook replay console.

## Evidence kept separate

| Level | State |
| --- | --- |
| Local | Passed at `4eda821` (351/351 API, 14/14 browser, guard passed); also at `1c3854c`, `e3c49dc` and `138869e` |
| GitHub CI | Pending (GitHub not linked) |
| Hosted | Pending (not approved) |
| Pilot | Pending |
