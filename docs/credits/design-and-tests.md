# Prepaid message credits: design and test evidence (test mode)

Owner decision of 29 Oct 2026 (ADR-042). Built and tested locally in **test mode**: the payment provider is a labelled
test provider (no money moves) and WhatsApp is the sandbox (nothing leaves the machine). Nothing is hosted, no partner
or payment account exists, and nothing is live.

## How it works

| Part | What it does | Where |
| --- | --- | --- |
| Accounts | One credit account per company, opened by a platform owner (one company at a time). Companies without one are untouched and keep paying Meta directly. | `credit_accounts`, `platform_credit_open_account` |
| Ledger | Every change is one append-only entry (top-up, reserve, release, charge, refund, reversal, adjustment). A trigger applies it to the account in the same statement; a guard refuses any other change to the balance. | `credit_entries`, `credit_apply_entry`, `credit_accounts_guard` |
| Rates | Rate cards per currency with an effective date; lines per market and category; markets from the longest calling-code prefix, with an `other` fallback. Cards never change; a new price is a new card. | `credit_rate_cards/lines/markets`, `platform_credit_publish_rates` |
| Margin | Default margin plus an optional per-company margin, in basis points; price = cost × (1 + margin), rounded half-up. | `credit_settings`, `platform_credit_set_margin` |
| Reserve | When a paid message is about to be sent (marketing or authentication template, or a utility template outside the 24-hour window), its price is reserved from the available balance under the account's row lock. Not enough credit: the message is not sent (`insufficient_credit`). | `reserveForSend` in the sender |
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

Payment providers plug in through one interface (`createCheckout`, `chargeSaved`, `refund`, `verifyEvent`). Only the
test provider exists; production refuses it (`CREDITS_PROVIDER=test`), so production has no top-ups until a real
provider is added after approval.

## Not built yet (needs an approval or an outside account)

- The Solution Partner adapter (360dialog sends through its own endpoint and key: the WhatsApp adapter needs a new
  base address and authentication). Needs owner actions 4 and 16.
- A real payment provider (Stripe recommended). Needs owner action 17.
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

The reviewer rechecked the fixes and confirmed them. They found no remaining deadlock path and raised six smaller points, fixed as follows:

- Campaign messages waiting for the daily limit no longer keep their credit held, so other messages can still use it.
- The credit lock is taken only for templates; replies and media are never held up by it.
- A refund still pending when the bank takes a payment back does not protect part of that payment.
- A second partial dispute of the same payment is applied.
- A refund the provider never answers is retried at most 30 times. The company is then told, and the platform owner checks it with the provider.
- Platform reconciliation uses UTC calendar months, matching the partner's invoices. The company's own statement uses the company's time zone.

As before, the worker's look-up functions remain callable by the application role, the same pattern as every other worker job.

## Recheck and further fixes (migration 0063)

The reviewer rechecked the fixes and confirmed them, finding no lock cycle. Remaining gaps, now fixed:

- **Campaign holds:** campaign messages waiting for room under the daily limit no longer keep credit held, so a large campaign cannot starve other paid messages.
- **Lock taken only when needed:** only template messages, the only kind that can be paid, take the company's credit lock. Free replies and media do not, so a slow file read cannot hold up credits.
- **Disputes:** a dispute counts only refunds that went through. A second partial dispute of the same payment applies too, never more than the payment.
- **Refunds with no answer:** a refund the provider never answers is tried 30 times. The company is then told, and a person checks it with the provider; the money stays out of the balance until then.
- **Reconciliation months:** platform reconciliation uses calendar months in UTC, explicitly, to match the partner's invoice. The company's own statement uses its own time zone.

## Test evidence (29 Oct 2026)

- Clean checkout of a1093b8, built and tested from nothing (`docs/reports/evidence/clean-checkout-a1093b8.txt`): install from the lock file, strict dependency audit with no advisories, build, lint, type check, migrations 0001–0063, the isolation guard, 684 of 684 API tests and 16 of 16 browser checks (English and Arabic at three sizes, including the credits screen). Result: all checks passed.
- `apps/api/test/credits.test.ts` holds the 32 message-credit tests; `isolation.db.test.ts` fills every credit table for two companies and confirms neither can see the other's rows.
- Screens: `docs/reports/evidence/ui/*-credits.png`.
- Not tested, because they don't exist yet: a real payment provider, the Solution Partner's API, Meta's live pricing webhooks (the tests use Meta's documented `pricing` fields through the sandbox) and hosting.
