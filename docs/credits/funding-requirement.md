# Funding requirement for prepaid message credits (partner route)

Prepared 29 Oct 2026. Planning figures, not confirmed costs: 360dialog's written quote and Meta's own rate card file
are still to come. Every assumption is stated so it can be changed.

## How the money moves (two separate ledgers)

1. **Customer money (in):** companies top up through Stripe → Stripe pays out to Meronatic's US bank. Recorded per
   company in `credit_topups` and the credit ledger.
2. **Partner funding (out):** Meronatic tops up its prepaid 360dialog balance → 360dialog pays Meta as messages are
   delivered. Recorded in `partner_funding_entries` (funding, invoices, fees) and `partner_balance_snapshots`.

The two never mix in the software. The partner balance must always be ahead of usage, because 360dialog pauses all
customers' sending at zero. Customer money arrives later than it is spent: Stripe's first payout comes 7–14 days
after the first live payment and then T+2 business days, and a bank transfer to 360dialog takes days more.

## What the monitor watches (built, test mode)

Every minute the worker computes, in the partner's currency:

- **Cost per day:** Meta's cost of what prepaid companies sent, taking the higher of the 7-day and 30-day averages.
- **Days of cover:** the partner balance divided by cost per day.
- **Buffer required:** cost per day × (minimum days of cover + top-up lead days) × (1 + safety margin), and never
  less than the low-balance floor.
- **Customers' unspent credit**, converted at the pegged rates (SAR 0.2666, AED 0.2723 per USD).

It raises an alert once, and clears it when the condition ends, for each of these:

- the balance is below the floor;
- cover is shorter than the minimum days;
- the balance is below the required buffer;
- no balance figure has been recorded in the last 24 hours.

The defaults are a floor of USD 500, 14 days of cover, 5 days' lead and a 50% safety margin. They can be changed in
the platform console. Until 360dialog's balance API is confirmed, a platform owner records the balance.

## Assumptions

| Item | Value used | Source / status |
| --- | --- | --- |
| Monthly messages per customer number | 1,000 marketing, 2,000 utility, 200 authentication, 3,000 service replies | Assumed profile for an AC-maintenance company; replace with pilot data |
| Meta rates, Saudi Arabia, USD per message (from 1 Oct 2026) | Marketing 0.0662; utility, authentication and service 0.0123 | Secondary source (Gallabox rate card page). Another source gives 0.0576 / 0.0107. The higher figures are used. Confirm from Meta's SAR/USD rate card files |
| Free service messages | 1,000 per number per month | Meta pricing page, read 29 Oct 2026 |
| 360dialog surcharge | 7% on marketing sent outside Meta's Marketing Messages API | 360dialog pricing page (ConversaFlow sends marketing through the standard messages endpoint today) |
| 360dialog plan | Cheapest published plan for the number count | 360dialog pricing page, USD prices |
| Stripe | 5.4% + $0.30 per top-up (Saudi card, conversion to USD) | stripe.com/pricing |
| Refund reserve | 5% of customers' unspent credit | Assumption |
| Chargeback reserve | 1% of monthly top-ups + $15 per expected dispute | Assumption |
| Customers' unspent credit | About one month of usage | Assumption |

## Results

Meta's cost per customer number is about USD 117.86 a month, plus USD 4.63 for the 360dialog marketing surcharge,
so about USD 122.49 a month (USD 4.08 a day).

| | 5 numbers | 10 numbers | 50 numbers |
| --- | --- | --- | --- |
| Meta cost + surcharge per month | $612 | $1,225 | $6,125 |
| Cost per day | $20.4 | $40.8 | $204.2 |
| 360dialog plan per month (cheapest published) | $300 (Starter) | $595 (Starter + 5 × $59) | $1,740 (Premium + 30 × $18) |
| Stripe fees on top-ups per month (approx.) | $41 | $82 | $412 |
| **Partner balance buffer** (19 days × 1.5) | $582 | $1,164 | $5,818 |
| First-payout float (14 days of usage before Stripe's first payout) | $286 | $572 | $2,858 |
| Refund reserve | $31 | $61 | $306 |
| Chargeback reserve | $21 | $27 | $136 |
| First month's 360dialog plan, paid in advance | $300 | $595 | $1,740 |
| **Initial funding required** | **about $1,220** | **about $2,420** | **about $10,860** |
| Fixed running cost per month (partner plan + Stripe fees) | $341 | $677 | $2,152 |

**What this means for pricing:** at a 20% margin on Meta's cost, credits earn about $24 per number per month. That
does not cover 360dialog's plan fee, which is about $35–60 per number a month depending on volume, plus about $8 per
number of Stripe fees. The partner fee must be recovered through the ConversaFlow subscription or a per-number charge,
or the margin raised. This is a launch decision (see `launch-decisions.md`).

## Running it

- **At launch:** fund the partner balance with the buffer for the expected number count, and keep the float and the
  reserves in Meronatic's bank account.
- **Weekly at first, then whenever an alert fires:** top up the partner by bank transfer. A card payment costs 4%
  more at 360dialog. Record the transfer and the balance in the console.
- **Monthly:** enter 360dialog's invoice per company in the reconciliation. Differences against our ledger are
  flagged.
