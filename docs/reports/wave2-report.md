# Wave 1 completion and Wave 2 — progress report

Branch `feature/brd-v1.2-wave1`. Candidate 3 (`rc3-tested` = `f1bc095`, `rc3-packaged` = `c3b6d3d`) and the slice 4
package (`w1s4-tested` = `ffdc5c7`, `w1s4-packaged` = `632272b`) are unchanged.

**What these results are.** Every result here is **local verification only**: WhatsApp is the sandbox (simulated),
the AI is the simulated provider (labelled as such on every screen), and all data is test or demo data. Nothing has
run in GitHub CI, in a hosted environment or against a live service. File scanning is verified only with the
scanner's test signature. Message-ID correlation still needs confirming against the real provider.

"Clean checkout" means the commit was checked out into an empty folder, installed from the lock file and put
through build, lint, type check, migrations from empty, the isolation guard, the API suite and the browser checks.

## Commits

| Commit | What | Evidence |
| --- | --- | --- |
| `dbaacee` | AX-3: incoming webhook events recorded by the request and applied by the worker (0042) | Clean checkout passed, 504/504 API |
| `6b01e08`, `0f5f43f`, `6b47a5f` | W1.9: Click-to-WhatsApp ad report; resolve and reopen conversations (0043); type and isolation-test follow-ups | `0f5f43f` clean checkout failed (isolation test missing the new table), fixed in `6b47a5f`: passed, 511/511 |
| `41cacc9` | AX-3 review fixes M1, L1–L5 (0044) | Targeted tests |
| `7223136` | W2.1: automations with versions, rehearsal and safety controls (0045) | Clean checkout passed, 525/525 API, 15/15 browser. Independently reviewed: 4 Medium, 8 Low |
| `c6d0d95` | Recheck fixes for AX-3 and W1.9: N1–N3, W1–W3 (0046) | Clean checkout passed. Recheck: 5 of 6 resolved, W2 partly; three new Low |
| `6e490a1` | W2.2/W2.3: company AI agent and agent assistance (0047) | Clean checkout passed, 540/540 API, 15/15 browser. Independently reviewed: 4 High, 7 Medium, 5 Low |
| `fe07938` | W2.1 review fixes M1–M4, L1–L8 (0048) | Full run 547/547 API, 15/15 browser. Recheck: all resolved except L4 (partly) and one screen item; one new Medium (N1), two new Low |
| `b1564ba` | W2.2/W2.3 review fixes H1–H4, M1–M6, L1–L4 (0049) | Full run 554/554 API, 15/15 browser; clean checkout passed. Recheck: all bypasses from the first review caught; three new Medium (N1–N3), two Low |
| `434c297` | W2.1 recheck fixes N1–N3, L4 gap (0050) | Full run 558/558 API, 15/15 browser; clean checkout passed |
| `a1ede55` | AI recheck fixes N1–N5, N7, M2 gaps, L3, L5 | Full run 564/564 API; browser 15/15 run separately. Second recheck: answer mode acceptable for one closely watched pilot after three changes |
| `05d3da1` | AX-3/W1.9 second recheck: ad rows, assignment try-lock, delayed events on health | Targeted 40/40 |
| `849692b` | W2.4: customer page with expiring, revocable links (0051) | Full run 583/583 API, 15/15 browser. Independently reviewed: no High, 4 Medium, 6 Low |
| `485a67c` | AI second recheck fixes (checks-4): dispatch, arrival and money wording; price adjacency; dates | Targeted 28/28. Clean checkout failed: two messages with the same timestamp were read in either order |
| `4272ad9` | Fix for that: messages ordered by time, then creation, then id | Covered by later full runs |
| `e4a5ed1` | W2.5: phone notifications and offline use (installable app, push, offline reply queue) (0052) | Full run 592/592 API, 16/16 browser. Independently reviewed (one High: push address allowlist) |
| `5f661c2` | W2.4 review fixes (customer page) | Full run 597/597 API, 16/16 browser |
| `b313489` | W2.6: promise tracking (0053) | Full run 604/604 API, 16/16 browser. Independently reviewed: 2 High, 7 Medium |
| `6425dca` | W2.5 review fixes (0054) | Full run 607/607 API, 16/16 browser |
| `655351e` | W2.6 review fixes (0055) | Full run 611/611 API, 16/16 browser; clean checkout passed |
| `89ffea2` | W2.8: public API v1 and outgoing webhooks (0056) | Full run 619/619 API, 16/16 browser. Independently reviewed: no High, 6 Medium, 6 Low |
| `8f96eff` | W2.8 review fixes (0057) | Full run 624/624 API, 16/16 browser; clean checkout passed |

Further commits are added to this table as they are verified.

## Decisions taken in the course of the work (routine, technical)

- Incoming events are applied by the worker in production (`INBOUND_APPLY=worker`, enforced); in-request apply is
  for development and tests only.
- An automation never takes a conversation away from a person; a person replying, being assigned, taking over,
  pausing replies or resolving stops automation runs, and their queued messages are not sent.
- Automatic assignment of a new conversation, and an automation's own "assign" step, do not stop the automation that
  is running: the assignment is part of the flow the company designed.
- AI "answer" mode is not available with the simulated AI in production. Answers the AI sends carry
  "(Automated reply)" / "(رد آلي)" unless the company turns that off (owner decision requested, item 11).
- Each AI call reserves its maximum cost against the company's monthly budget before the call and settles it after.
- Webhook signing secrets are sealed with a new key, `WEBHOOK_SECRETS_KEY`, held outside the database (API and
  worker). It is generated into the staging secrets store with the other keys; no action is needed from you.
- Webhook addresses in production must be public, on port 443 or 8443; the address is checked again when connecting.
- Subscribing to a webhook event needs the same company-wide access to that data in the app (all conversations, and
  contacts where the event names one). Deliveries stop if the person who set the webhook up loses that access.
- A promise suggestion that is not confirmed by its deadline is closed automatically with a note in the history.

## Known residual items (recorded, not hidden)

- Customer page (W2.4, M3): the link token stays inside the stored copy of the message that carried it; the page
  masks links in the inbox and in AI output, and links expire and can be revoked.
- Data retention (AI M7 and webhook payloads): stored AI exchanges and webhook delivery payloads have no purge job
  yet; retention is part of W3.7 (CF-EXT-027) and its schedule is a company/legal decision (owner action 8).
- Failed API key attempts are rate limited per address but not written to a log yet.
- Trusted proxy: the customer page and API rate limits use the client address from the proxy in front of the API;
  the hosting set-up must pass it correctly (part of the staging plan).
- A pre-existing harmless log line in the web server ("location is not defined") during server rendering; tests pass.

