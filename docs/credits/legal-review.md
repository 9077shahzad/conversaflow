# Prepaid message credits: questions for legal and tax review

Added 29 Oct 2026 to owner action 8 (legal documents). These are questions for qualified counsel and a tax adviser in
Saudi Arabia and the UAE (and US counsel for the Delaware LLC). Nothing here is legal or tax advice; where the
software already behaves a certain way, that is stated so counsel can confirm or change it before anything goes live.

## 1. What is being sold

- MERONATIC SOLUTIONS GROUP, LLC (Delaware) sells business customers prepaid credit that is used only to pay for
  WhatsApp messages sent through ConversaFlow (Meta's per-message charges plus Meronatic's margin).
- The credit is not cash, cannot be transferred to another company, cannot be used outside ConversaFlow, and earns
  no interest. A Solution Partner (recommended: 360dialog) pays Meta and invoices Meronatic.
- Customers are companies (B2B). The product is not offered to consumers.

**Questions**
1. In KSA and the UAE, does selling prepaid, single-purpose platform credit to businesses need any licence or
   registration (stored value, e-money, payment services: SAMA, CBUAE), or is it ordinary prepayment for services?
   What wording keeps it clearly in the second category?
2. Does reselling Meta's messages with a margin need disclosure to customers, and does Meta's or the partner's
   agreement require particular wording in our terms (pass-through of WhatsApp Business policies)?
3. Do card schemes or the chosen payment provider (Stripe restricts "stored value" issued by others) need written
   confirmation of the model? (The payment-provider comparison recommends asking Stripe in writing.)

## 2. Tax treatment

**Questions**
4. **When is VAT due:** on the top-up (payment received in advance) or when credit is used? KSA VAT is 15%, UAE 5%.
   Is a prepayment for a single type of service taxed at receipt?
5. **Who accounts for VAT:** for a non-resident Delaware LLC selling to VAT-registered businesses, is it reverse
   charge by the customer in KSA and the UAE, or must Meronatic register? (Stripe's UAE page says B2B is reverse
   charge and a non-resident must register from the first B2C sale; the KSA position was not verified.)
6. **Documents:** is our receipt enough, or is a tax invoice needed, and must it be a ZATCA e-invoice (Fatoorah)
   for a non-resident? Today the software issues a numbered receipt (`CR-YYYY-000001`) for each paid top-up and a
   numbered credit note (`CN-YYYY-000001`) for each refund, both marked "not a tax invoice; tax treatment under
   review". Required fields (customer VAT number or TRN, Arabic text, QR code) can be added once confirmed.
7. **Margin and Meta's cost:** is the whole credit price the taxable amount, or is Meta's cost a disbursement?
8. **Withholding tax:** does KSA withholding apply to payments from Saudi customers to a non-resident, and to
   Meronatic's payments to the partner?
9. **US side:** any sales-tax or income-recognition point on deferred revenue from unused credit (when is it income)?

## 3. Refunds

What the software does now (test mode): only **unused** credit can be refunded, and never more than what is left of
the top-up it came from; a refund needs a reason, is recorded with a credit note, and is made through the provider
that took the payment. A payment the bank takes back (chargeback lost) removes that credit even if the balance goes
below zero; paid messages then stop until a top-up.

**Questions**
10. Must unused credit be refundable on request, on termination, or only when the law requires it? Can a
    processing-fee deduction be kept (card fees are about 5.4% + $0.30 on a Saudi card with Stripe US)?
11. Is a refund to the original card required, or may we refund by bank transfer for large or old top-ups?
12. What happens to credit already spent when a chargeback succeeds (the customer received the messages)? Can the
    negative balance be invoiced and collected?

## 4. Unused balances

**Questions**
13. **Expiry:** may credit expire (for example 12 or 24 months after the last top-up, with notice)? If yes, what
    notice and wording? The software has no expiry today.
14. **Dormant balances:** do unclaimed-property or dormant-balance rules apply (Delaware unclaimed property for a
    Delaware LLC; any KSA or UAE equivalent)?
15. **Account closure:** on termination by either side, is the unused balance refunded, and within what time?
16. **Price changes:** Meta changes its rates from time to time. Can new rates apply to existing credit (the software
    prices each message at the rate card in force when it is sent, and keeps the price it reserved)?
17. **Insolvency or partner failure:** do customer prepayments need to be held separately (trust or segregated
    account), given that the partner's own balance is prepaid and pauses sending at zero?

## 5. Automatic top-up

What the software does now: off by default; turned on only by a person with billing permission who agrees to this
exact wording, and the time, person and wording are stored:

> I authorise ConversaFlow to charge the saved card the amount below whenever our available message credit falls
> under the threshold, up to the daily limit, until I turn this off.

It charges at most one top-up at a time and within the daily limit; a declined card is not retried in a loop and the
company is told.

**Questions**
18. Is this wording enough as a merchant-initiated-transaction mandate under card scheme rules and local consumer or
    e-commerce law (even for B2B)? Does each charge need a notice, and how much in advance?
19. Should there also be a monthly cap and a cooling-off or cancellation right?

## 6. Terms the software already assumes

- Credits are separate from the subscription; ending a subscription does not consume credit.
- Free messages (Meta's free service window, and anything Meta marks as not billable) are never charged.
- A message is charged once, when WhatsApp confirms delivery and that it is billable; failed messages are not charged.
- Prices are shown in the account's currency (SAR, AED or USD); the margin is configurable per company.

Counsel should confirm these, supply the customer-facing terms (prepaid-credit policy, refund policy, auto top-up
terms) and say what must appear on the website before the payment provider and partner accounts are opened.
