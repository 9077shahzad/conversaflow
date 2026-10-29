# Provider enquiries: 360dialog and Stripe

Owner approval of 29 Oct 2026: contact 360dialog sales (preferred candidate, subject to written confirmation) and
Stripe. No account opening, paid plan or agreement.

## Status (29 Oct 2026)

| Provider | Route | Status |
| --- | --- | --- |
| 360dialog | Web form at start.360dialog.com ("Connect to my software" → "For many businesses" → contact details). The form takes contact details only, no written message; sales then reply by email. Their other sales channel is a WhatsApp chat. | **Not yet sent.** The form requires a phone number, which I have asked you for. The email will be shehzad_falak@yahoo.com, as you chose. |
| Stripe | Sales form at stripe.com/contact/sales. | **Not yet sent.** The form refuses free email addresses such as Yahoo and asks for a company-domain work email. I have asked you whether one exists (for example @meronatic.com). Stripe's support contact needs a Stripe account, which I may not create. |

Nothing has been submitted to either provider, and no account has been created.

## Text to send to 360dialog

Subject: Partner-Paid pricing for an ISV (Tech Provider), Saudi Arabia and UAE

> We are MERONATIC SOLUTIONS GROUP, LLC (Delaware, USA), building ConversaFlow, a multi-company WhatsApp customer
> communication platform for service businesses in Saudi Arabia and the UAE. We plan to host our own Embedded Signup
> as a Meta Tech Provider in a multi-partner solution with 360dialog, on the Partner-Paid billing model, and to
> resell message credits to our customers.
>
> Please send a written, itemised quote for 5, 10 and 50 customer numbers, showing for each:
> 1. Partner Plan fee and what it includes; fee per additional number; any set-up fee.
> 2. Any per-message markup or surcharge (including the 7% on marketing messages not sent through the Marketing
>    Messages API), and whether volume discounts apply.
> 3. Taxes (VAT or withholding) for a Delaware LLC, your invoicing entity, and invoice currency (USD or EUR).
> 4. Minimum commitment, contract term, notice period and cancellation or exit fees; refund of unused balance.
> 5. Payment terms: can the Partner-Paid balance have postpaid or credit terms, or is it prepaid only? What happens to
>    customers' sending at zero balance, and can we set alerts or per-customer limits? Card fee versus bank transfer.
> 6. Support levels and response times for each plan, and whether Arabic or Gulf-hours support is available.
> 7. Confirmation that, with "Only my partner" sending, we can still use Meta's Graph API for templates and business
>    accounts, and that webhooks arrive in Meta's Cloud API format (and whether you sign them or let us set a header).
> 8. Onboarding limits (Meta's 200 new customers a week, throughput), restrictions for +966 and +971 numbers or
>    business categories, and the cost of the higher-throughput option.
> 9. Whether your partner terms require us to show 360dialog or Meta terms to our customers, and whether a DPA is
>    available.
>
> We are evaluating now and will decide after receiving written answers; please do not activate any paid plan.

## Text to send to Stripe

Subject: Eligibility and prepaid usage credits, US LLC selling to businesses in Saudi Arabia and the UAE

> We are MERONATIC SOLUTIONS GROUP, LLC, a Delaware limited liability company with an EIN and a US bank account,
> owned 50/50 by two non-US-resident members. We sell a B2B software service (ConversaFlow, WhatsApp customer
> messaging) to companies in Saudi Arabia and the UAE: monthly subscriptions, and prepaid usage credits that customers
> top up and that are consumed only on our platform to pay for their WhatsApp messages (non-transferable, no cash
> value, refundable only as unused credit).
>
> Please confirm in writing:
> 1. That this LLC structure (non-resident owners, US entity) is eligible for a US Stripe account, and which owner
>    identity documents and tax numbers (SSN or ITIN) you will need.
> 2. That the prepaid usage-credit model is acceptable under your restricted-business rules, and on what conditions.
> 3. Processing fees for our case: domestic and international cards, currency conversion, and Stripe Billing.
> 4. Whether SAR and AED are available as charge currencies on a US account, and settlement in USD.
> 5. Settlement and payout timing (first payout and after), and whether a reserve would apply, how it is set and when
>    it is released.
> 6. Dispute fees and process; whether saved cards can be charged off-session for automatic top-up with a customer
>    mandate.
> 7. Whether Stripe Tax covers Saudi Arabia and the UAE for B2B sales by a non-resident, and whether Managed Payments
>    (Stripe as merchant of record) would accept subscriptions and prepaid credits, with its fees.

## What we already know from published pages (to be confirmed in writing)

| Item | 360dialog | Stripe (US account) |
| --- | --- | --- |
| Fixed fee | Partner Plan €250/$300 a month (5 numbers), €500/$600 (10), €1,000/$1,200 (20); extra numbers €49/$59, €25/$30, €15/$18 a month | None |
| Per transaction or message | Meta rates passed through; +7% on marketing messages not sent through Meta's Marketing Messages API | 2.9% + $0.30 per card; +1.5% international card; +1% currency conversion; $15 per dispute |
| Currency | EUR or USD; 4% card fee | Charges in 135+ currencies; AED listed with a 2.00 minimum; **SAR not confirmed** for a US account |
| Settlement | Prepaid balance, deducted in real time; sending pauses at zero | First payout typically 7–14 days after the first live payment; then T+2 business days (US) |
| Reserves | Not stated | Not published for our case; prepaid models often draw one; ask |

Sources: 360dialog partner pricing and billing-model pages; stripe.com/pricing; docs.stripe.com/payouts and
docs.stripe.com/currencies (read 29 Oct 2026). Full source list in `partner-comparison.md` and `payment-providers.md`.
