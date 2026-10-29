# Prepaid messaging: decisions needed for launch

One consolidated list, 29 Oct 2026. Production payments and prepaid messaging stay disabled in the software until
items 9 and 10 are approved: production refuses any payment provider and the partner route.

| # | Decision or action | Who | Recommendation | Unblocks |
| --- | --- | --- | --- | --- |
| 1 | **Contact details for the enquiries:** a phone number for the 360dialog form, and a company-domain email for Stripe's sales form (it refuses Yahoo) | You | Use one company mailbox (for example @meronatic.com) for both, so replies are on record | Sending the two enquiries |
| 2 | **360dialog:** review the written quote for 5, 10 and 50 numbers, then approve or reject the Partner-Paid agreement and plan | You, after the quote | Choose the plan by expected numbers in the first 6 months (published: Starter $300 for 5, Premium $1,200 for 20 + $18 per extra); pay by bank transfer, since cards cost 4% more | Live partner route |
| 3 | **Stripe:** open the US account once Stripe confirms the prepaid model in writing; you and the co-founder complete the identity checks in Stripe's pages | You and co-founder | Proceed only with that written confirmation; apply for an ITIN early if Stripe needs one | Live top-ups |
| 4 | **Charge currency:** SAR is not confirmed as a charge currency on a US Stripe account | You, after Stripe's answer | If SAR is not available, charge in USD and show SAR equivalents; AED is listed | Customer pricing pages |
| 5 | **Meta:** business verification, Tech Provider registration and app review; accept the multi-partner solution with 360dialog (it cannot be undone later) | You (documents), me (recordings and texts) | Start verification now; it is the longest chain | Any live WhatsApp number |
| 6 | **Pricing:** margin on Meta's cost, and how to recover the partner's fee of about $35–60 per number a month plus about $8 of payment fees | You | Keep a 20% margin on messages and add a per-number partner charge to the subscription. Alternatively set the margin at about 50%, though messages then look expensive next to paying Meta directly | Rate cards and plans to publish |
| 7 | **7% marketing surcharge:** pass it on, or build Meta's Marketing Messages API route to avoid it | You | Pass it on for the pilot; build the Marketing Messages API route if marketing volume is high | Marketing cost |
| 8 | **Initial funding and monitor settings:** about $1,220 (5 numbers), $2,420 (10) or $10,860 (50); defaults of 14 days' cover, 5 days' lead time, 50% safety and a $500 floor | You | Fund for the pilot's number count and keep the defaults (`funding-requirement.md`) | Partner balance |
| 9 | **Legal and tax answers and wording approval:** VAT and who accounts for it, receipts versus tax invoices and ZATCA, refunds, expiry and unused balances, licensing, and the automatic top-up wording in English and Arabic | Counsel, then you | Brief counsel with `legal-review.md`; approve wording versions in the console only with their reference | Automatic top-up, customer terms, receipts |
| 10 | **Which companies move:** existing companies stay on the direct route by default; name the pilot company for the partner route | You | One pilot company first | Opening credit accounts |
| 11 | **Production activation:** turn on Stripe live keys and the partner route in production (a configuration change I make on your approval) | You | After items 2–10 and the staging checks | Prepaid messaging in production |
| 12 | **The four open low findings** (L5, N7, P1, P2) | You | **Decided 29 Oct:** accepted for isolated test mode only. All four are fixed and tested before the first live partner number (`open-findings.md`) | First live partner number |
| 13 | **Meta's October 2026 pricing:** service replies after 1,000 free per number per month, and utility templates inside the 24-hour window, are now charged; ConversaFlow passes these on | You | Confirm, and add it to the customer terms | Customer communication |
| 14 | **Payments that cannot be applied:** who checks the platform alert and decides, for each kept payment, to credit it or refund it at Stripe, and within what time | You | The platform owner on duty, within one working day; each case is closed in the console as credit, refunded or closed, with what was done | Live top-ups |

Already on the general list and still needed first: staging hosting (owner action 3) and the risk decisions
(owner action 6).
