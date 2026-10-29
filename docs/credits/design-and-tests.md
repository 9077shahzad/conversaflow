# Prepaid message credits: design and test evidence (test mode)

Owner decisions of 29 Oct 2026 (ADR-042, and the instruction of 18:17). Built and tested locally in **test mode**:
payments go to a labelled test provider or to Stripe's API in test mode (only `sk_test_` keys are accepted), and
WhatsApp goes to the sandbox or to a local stand-in for 360dialog. Nothing leaves the machine in the tests, no money
moves, no partner or payment account exists, and nothing is live. Production refuses any payment provider, the
partner route and opening credit accounts.

## How it works

| Part | What it does | Where |
| --- | --- | --- |
| Accounts | One credit account per company, opened by a platform owner (one company at a time). Companies without one are untouched and keep paying Meta directly. | `credit_accounts`, `platform_credit_open_account` |
| Ledger | Every change is one append-only entry (top-up, reserve, release, charge, refund, reversal, adjustment). A trigger applies it to the account in the same statement; a guard refuses any other change to the balance. | `credit_entries`, `credit_apply_entry`, `credit_accounts_guard` |
| Rates | Rate cards per currency with an effective date; lines per market and category; markets from the longest calling-code prefix, with an `other` fallback. Cards never change; a new price is a new card. | `credit_rate_cards/lines/markets`, `platform_credit_publish_rates` |
| Margin | Default margin plus an optional per-company margin, in basis points; price = cost × (1 + margin), rounded half-up. | `credit_settings`, `platform_credit_set_margin` |
| Route | Each company has exactly one messaging and billing route: `meta_direct` (the default for every existing company: it pays Meta itself and is never charged credit) or `partner_360dialog` (prepaid credit). Set only by a platform owner, one company at a time, with a reason; refused while the company has live numbers, credit, held amounts, or top-ups or refunds in progress. The database refuses a credit account, or a live number of the wrong provider, that does not match the route, and the same WhatsApp number can never be live twice. | `messaging_routes`, `platform_set_messaging_route`, triggers in 0064/0065 |
| Partner numbers | Connected by a platform owner with the number's 360dialog API key, stored sealed (AES-256-GCM) and readable only by the API and worker. Messages, templates and media go to 360dialog in Meta's Cloud API format; its webhooks need a secret header. | `dialog360.ts`, `platform_partner_connect_channel` |
| Reserve | When a paid message is about to be sent (any template Meta bills, and from 1 Oct 2026 replies after the number's 1,000 free service messages in the month), its price is reserved from the available balance under the account's row lock. Not enough credit: the message is not sent (`insufficient_credit`). | `reserveForSend` in the sender |
| Charge | Meta's delivery status carries `pricing.billable` and the category. Billable and delivered (or read): charged once per message, at the reserved price, whatever the number or order of webhooks. Not billable: released. Failed: released. | `settleOnStatus` |
| Stale | Reservations never billed are released by the worker after `reservation_hours` (72 by default). | `credit_reservations_stale`, `CreditWorker.releaseStale` |
| Top-ups | A pending top-up, then the provider's checkout. Credit is added only from a verified, signed provider event whose company, top-up, reference, amount and currency all match; each event is applied once. Receipt `CR-YYYY-000001`. | `credit_topups`, `credit_payment_events`, `applyPaymentEvent` |
| Failed payment | Recorded with a notice; no credit. | same |
| Refunds | Only unused credit, never more than what is left of the top-up; the provider is asked while the account is locked; credit note `CN-YYYY-000001`. | `credit_refunds`, `CreditsService.refund` |
| Chargeback | A lost dispute removes that top-up's credit once, even below zero; paid sends then stop. | `dispute.lost` |
| Adjustments | Platform owner only, with a reason; recorded in the company's audit trail. | `platform_credit_adjust` |
| Alerts | Low-balance and empty notices once per episode, re-armed when credit is back above the threshold. | `credit_notices` |
| Automatic top-up | Off by default. On only with the exact consent wording, a saved card, a threshold, an amount and a 24-hour limit; one pending at a time; a declined card is not retried in a loop. | `setAuto`, `CreditWorker.autoTopUps` |
| Statement | Opening and closing balance, top-ups, charges, refunds, reversals and adjustments for a month. | `GET /v1/credits/statements/:month` |
| Reconciliation | Per company and month: messages charged, price, our cost, margin, the partner's figure and the difference (`matched`, `difference`, `awaiting_partner_figure`). | `platform_credit_reconciliation` |
| Screen | `/[locale]/app/credits` in English and Arabic with a test-mode banner. | `apps/web/app/[locale]/app/credits/page.tsx` |

Payment providers plug in through one interface (`createCheckout`, `chargeSaved`, `refund`, `refundStatus`,
`verifyEvent`). Two exist: the test provider and Stripe (Checkout Sessions, off-session PaymentIntents, refunds and
disputes, webhook signatures checked with a 5-minute window). Production refuses both until launch is approved.

**Meta's pricing from 1 October 2026.** Service replies are charged at the utility rate after 1,000 free per number per
month, and utility templates inside the 24-hour window are charged. Free entry-point conversations stay free. The
software holds credit for these and charges only what Meta's status marks billable. Several replies sent at the same
moment can pass the 1,000th together; Meta may then charge a few replies that were not held, and those are charged on
delivery like any unreserved billable message (the balance can go slightly below zero, and paid sends then stop).

## Not built yet (needs an approval or an outside account)

- Live connections: a 360dialog partner account and a Stripe account (both need your approval and the written
  provider answers). The adapters are built and tested against local stand-ins only.
- Saving a card through Stripe for automatic top-up (Checkout in `setup` mode). Automatic top-up stays disabled until
  the wording is approved, so this is built with the Stripe account.
- Reading the partner's balance automatically from 360dialog: entered by a platform owner for now; the monitor raises
  a "stale balance" alert after 24 hours without a figure.
- Tax invoices, VAT and expiry rules: waiting for the legal and tax answers (`docs/credits/legal-review.md`).
- Importing the partner's invoice automatically: the partner figure is entered by a platform owner for now.
- A platform screen for rates, margins and reconciliation: the platform API exists; the screen does not.

## Independent review and fixes (migration 0062)

An independent review of the first version found 2 High, 6 Medium and 9 Low issues. Fixed before anything is used:

| Finding | Fix |
| --- | --- |
| H1 A billable delivery after the hold was released (late delivery, or after a failed status) broke a unique rule and stalled the whole webhook group | Only "one charge per message" is unique; such a delivery is charged once, with no hold to release |
| H2 A refund called the provider while holding the company's lock; a failure after the provider paid out lost the record | Two steps: the amount is taken out (pending) first, the provider is asked with no lock held, then settled or given back; the worker retries pending refunds with the same idempotency key |
| M1 Possible deadlocks between sending, delivery statuses and payments | One lock order everywhere: the company's credit account first; free messages take no lock |
| M2 A hold could be released while its message still waited (campaign limit), then sent without a hold | Messages still waiting keep their hold; a message sent again is held again |
| M3 Disputes after a partial refund took the refunded part twice; partial disputes ignored; a payment confirmed after "failed" not credited | Only the unrefunded part is taken back; partial disputes apply; late confirmations credit once |
| M4 An event arriving before our reference was saved was lost for good; an automatic top-up never confirmed blocked automatic top-up | Unmatched events are not remembered (the provider's retry applies); unconfirmed automatic top-ups are closed with a notice |
| M5 Statement balances could be read out of order | Each entry gets a per-company number under the lock |
| M6 A changed category was priced at today's card; Meta sub-categories unmapped | Priced on the reserved card (or the card in force when sent); sub-categories mapped |
| L1–L9 | Test provider off unless set explicitly; test receipts marked TEST; promotional credit not refundable as cash; closed accounts; statement months in the company's time zone; saved cards removable; return from test checkout handled |

Accepted as they are (recorded, not changed): the worker's look-up functions are callable by the application role, as for every other worker job (L5); the application role can write ledger rows the database does not tie to a payment (defence in depth, L6); partner invoices in another currency than the company's balance show as a difference (L8).

One consequence of M1: for a company on prepaid credit, the preparation and recording steps of its outgoing **templates** run one at a time (short database steps; the call to WhatsApp is not inside them). Replies, media and companies paying Meta directly are not affected.

## Recheck and further fixes (migration 0063)

The reviewer rechecked the fixes and confirmed them, finding no lock cycle. Remaining gaps, now fixed:

- **Campaign holds:** campaign messages waiting for room under the daily limit no longer keep credit held, so a large campaign cannot starve other paid messages.
- **Lock taken only when needed:** only template messages, the only kind that can be paid, take the company's credit lock. Free replies and media do not, so a slow file read cannot hold up credits.
- **Disputes:** a dispute counts only refunds that went through. A second partial dispute of the same payment applies too, never more than the payment.
- **Refunds with no answer:** a refund the provider never answers is tried 30 times. The company is then told, and a person checks it with the provider; the money stays out of the balance until then.
- **Reconciliation months:** platform reconciliation uses calendar months in UTC, explicitly, to match the partner's invoice. The company's own statement uses its own time zone.

## Partner route review and fixes (migration 0065)

An independent review of the partner route (commit 0f83560) found 2 High and 6 Medium issues and several Low ones.
Fixed in 51daa71:

| Finding | Fix |
| --- | --- |
| H1 A credit account opened before routes existed stayed active for a company on the direct route, which would charge it twice (Meta and us) | Such accounts are closed and the company keeps direct billing; it is never moved to the partner route (that needs a platform owner's explicit switch for that company). The migration stops if such an account still holds credit or payments in progress. The database also checks the route when an account is reactivated, and the code checks it again before any charge |
| H2 A Stripe automatic top-up could be paid before our reference was saved; its webhook was then dropped with a success answer, so Stripe never retried and the customer paid without receiving credit | The event names our top-up, company, amount and currency, all checked, so its reference is adopted. An event that still cannot be applied is kept with a platform alert (see "Payment recovery") |
| M1 Route changes and new numbers could race | One lock per company for route changes, numbers and accounts |
| M2 A switch back to direct ignored top-ups and refunds in progress; a closed account could never be reopened | Refused while either is in progress; a closed account can be reopened in its original currency |
| M3 Production could still move a company to the partner route | Refused in production, as is opening a credit account |
| M4, M5 The sender decided twice whether a reply may be paid, which could take the credit lock out of order | Decided once, before any lock (a message with a hold kept counts as paid) |
| M6 Stripe's "pending" refunds were treated as completed | Kept pending with Stripe's reference; the worker asks Stripe for the refund's state |
| Low | Consent: a change of language is checked too. Funding: the buffer covers customers' unspent credit, figures must be in the partner's currency, closed accounts' usage counts, and the check cannot be called from a company's context. Stripe: any one of several signatures (secret rotation) is accepted; live events are refused |

Six new tests cover these (`apps/api/test/partner.test.ts`, "fixes from the review of 0064").

A recheck of these fixes found three more Medium points, fixed in 521e0af: starting a top-up now locks the account,
so a route switch cannot close it in between; the migration closes old accounts instead of moving them; and events
that cannot be applied are kept rather than refused. Lows fixed there too: one lock order when opening an account,
Stripe refunds pending for more than three days are escalated to a person, and an event from the other Stripe mode
(live or test) is refused.

## Payment recovery: exactly one credit (owner instruction of 29 Oct, point 2)

| Situation | What happens | Test |
| --- | --- | --- |
| The webhook arrives before our reference is saved | The event's top-up, company, amount and currency are checked and its reference adopted; credited | "early, repeated…" |
| Stripe sends the same event again | Recognised by its event id; nothing more happens (`duplicate`) | same |
| A second notice for the same payment (for example `async_payment_succeeded` after `completed`) | The top-up is already paid (`already_applied`) | same |
| Out of order: "expired" after "paid" | Ignored (`not_pending:succeeded`) | same |
| Every webhook lost, or Stripe stops retrying | The worker looks each pending top-up up with Stripe directly (after 10 minutes, then at most every 10 minutes) and applies the answer through the same path; the late webhook then changes nothing | "every webhook lost…" |
| An automatic top-up closed as unconfirmed, paid later | Looked up for three more days; credited once | "an automatic top-up closed…" |
| An event that can never be applied (unknown top-up, different amount, account closed) | Kept once in `credit_unmatched_events` with a platform alert; a platform owner refunds or credits by hand and closes it in the console with what was done | "a payment that can never be applied…" |

Each credit is one ledger entry tied to its top-up, and the tests count those entries as well as the balance.

## Test evidence (29 Oct 2026)

- Clean checkout of a1093b8, built and tested from nothing (`docs/reports/evidence/clean-checkout-a1093b8.txt`): install from the lock file, strict dependency audit with no advisories, build, lint, type check, migrations 0001–0063, the isolation guard, 684 of 684 API tests and 16 of 16 browser checks (English and Arabic at three sizes, including the credits screen). Result: all checks passed.
- `apps/api/test/credits.test.ts` holds the 32 message-credit tests; `isolation.db.test.ts` fills every credit table for two companies and confirms neither can see the other's rows.
- Screens: `docs/reports/evidence/ui/*-credits.png`.
- Not tested, because they don't exist yet: a real payment provider, the Solution Partner's API, Meta's live pricing webhooks (the tests use Meta's documented `pricing` fields through the sandbox) and hosting.
