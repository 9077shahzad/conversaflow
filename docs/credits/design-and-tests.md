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
