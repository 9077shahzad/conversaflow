# Provider enquiries: 360dialog and Stripe

Owner approval of 29 Oct 2026: contact 360dialog sales (preferred candidate, subject to written confirmation) and
Stripe. No account opening, paid plan or agreement.

## Status (29 Oct 2026, 23:50 Gulf time)

| Provider | Status | Blocker or next step |
| --- | --- | --- |
| 360dialog | **Not sent.** | Their form (start.360dialog.com → "Connect to my software" → "For many businesses") requires a phone number, which I don't have yet. The company email to use is admin@meronatic.com. |
| Stripe | **Sent.** Asked through Stripe's support assistant and then a Stripe support agent (Parv), signed in as Meronatic Solutions Group, LLC (account acct_1SvZbDEHkJJapxhg, application "submitted"). The agent pointed to stripe.com/pricing for fees and to the dashboard for currencies, and passed the remaining questions (prepaid model, our fees, SAR, reserve) to a dedicated team as an email case, **case reference sco_VX3A5bt0S8nVhl** (last character read from the chat screen; l or I), replies to admin@meronatic.com. Contact name given: Muhammad Shahzad; planning volume given: about USD 1,500 to 7,500 a month in the first year. | Stripe's sales form sends pre-revenue companies to self-service sign-up, so support was used. Waiting for the email reply; the business phone number is to follow by email when you have it. |

No account was created by me, no plan activated and no agreement accepted.

### Stripe sales (Ahmed, Sales | Growth), written reply received 30 Oct 2026

The first written answer from a Stripe person (by email to admin@meronatic.com, after the case above):

1. **Prepaid usage credit:** "supportable with Stripe": customers pay or top up through Checkout; Stripe suggested
   holding the credit as a Stripe customer balance. ConversaFlow keeps the balance in its own ledger instead and only
   uses Checkout and saved cards, which fits the same answer; no change needed, to be mentioned on the call.
2. **Fees:** the standard published US pricing: 2.9% + 30¢ for cards and wallets, +0.5% for manually entered cards,
   +1.5% for international cards, +1% when currency conversion is needed. A Saudi or UAE card paying in SAR or AED
   therefore costs about 5.4% + 30¢ (2.9 + 1.5 + 1).
3. **Currencies:** SAR (and AED) can be used as charge currencies on the US account; settlement is in USD.
4. **Reserve:** not answered for our account; Stripe sent its general articles on reserves and rolling reserves.
5. **Next step on Stripe's side:** a standard risk review, for which Stripe asks for a ConversaFlow website or at
   least a social media page. ConversaFlow has no public website yet (conversaflow.io is registered but not
   connected), so this is now a decision for you (see launch decisions).

### Stripe's support assistant: preliminary answers (AI assistant, 29 Oct 2026; not a written confirmation)

1. **Eligibility:** a Delaware LLC with an EIN and a US bank account is eligible whether or not its owners live in the
   US. Owners without an SSN or ITIN may give their local tax ID plus documents showing they are not US taxpayers.
   The account representative's ID is checked at onboarding; non-resident owners' IDs once lifetime volume passes
   $500,000. Standard business details (legal name, EIN, address) are also needed.
2. **Prepaid credits:** the model as described is "consistent with a standard prepaid usage-credit or usage-based
   billing structure", which differs from stored value or money transmission; final eligibility is decided at account
   review.
3. **Fees:** not given in that channel; it pointed to stripe.com/pricing and stripe.com/billing/pricing, with account
   terms confirmed after review.
4. **Currencies:** 135+ presentment currencies; SAR and AED to be checked on the supported-currency list; charges in
   other currencies convert to USD at settlement unless multi-currency settlement is set up.
5. **Payouts and reserves:** first payout about seven days after the first live payment, then on the chosen schedule.
   A reserve is not automatic; it depends on underwriting, and Stripe would email the amount and duration.
6. **Disputes and automatic top-up:** a dispute fee applies, plus a fee to counter one. Off-session charges for
   automatic top-up are allowed when the card was saved for future use with a customer mandate.
7. **Stripe Tax:** for Saudi Arabia it covers B2C digital services by remote sellers; B2B sales by a non-resident
   generally do not require registration. UAE coverage for remote sellers is to be checked. It noted this is not tax
   advice.

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
