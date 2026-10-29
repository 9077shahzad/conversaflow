# Stripe application and Meta verification: what is needed

Prepared 29 Oct 2026 for MERONATIC SOLUTIONS GROUP, LLC (Delaware). The LLC is manager-managed, owned 50/50 by
Muhammad Shahzad and Muhammed Sheikh, and has an EIN (147C letter) and a US bank account.

The identity checks and owner declarations below must be completed by you, and the co-founder, directly in Stripe's
and Meta's own secure pages. Never send them in chat or email, and never put them in the code.

## Stripe (US account, test mode first)

**Company**
- Legal name exactly as on the Certificate of Formation; EIN, with the IRS letter (CP575 or 147C).
- Registered address in Delaware, and a business address that is not a PO box (Stripe asks for one).
- A US phone number.
- The US business bank account in the LLC's name, for USD payouts.
- Business description: "B2B software for WhatsApp customer messaging; customers prepay usage credits consumed only
  on our platform". Industry: software / SaaS.
- A live website that shows:
  - prices in SAR, AED and USD;
  - terms of service, privacy notice and refund and cancellation policy;
  - the prepaid-credit policy (non-transferable, no cash value, refund rule for unused credit, any expiry);
  - the automatic top-up terms;
  - support contact, and the company's legal name and address.

**People (each needs their own identity check, done in Stripe's onboarding)**
- **The representative:** the person opening the account, normally a manager. Full name, date of birth, home
  address, phone, ownership percentage and title, a government photo ID, and an SSN or ITIN where Stripe asks for one.
  Whose SSN or ITIN Stripe needs when the owners are not US residents is not confirmed; it is in the enquiry. If
  neither of you has an ITIN, apply early: it takes weeks.
- **Every owner with 25% or more:** both of you, with the same details. The co-founder completes his own part.
- **Declarations:** that the information is accurate, and acceptance of the Stripe Services Agreement and its
  restricted-business terms. Do not accept these until Stripe has confirmed the prepaid-credit model in writing.

**Settings once the account exists**
- Test mode keys go into the staging secrets store, never into chat or the code. ConversaFlow refuses live keys and
  refuses payments in production until you approve.
- Webhook endpoint `/v1/webhooks/credits/stripe` with these events: `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `payment_intent.succeeded`, `payment_intent.payment_failed` and `charge.dispute.closed`.
- Payment currencies: confirm that SAR and AED are enabled. Then test real Saudi co-badged mada/Visa and
  mada/Mastercard cards with small amounts, but only once live payments are approved.
- Optional: Stripe Tax and tax ID collection (KSA VAT number, UAE TRN), after the tax advice in
  `legal-review.md`.

## Meta (business verification and Tech Provider), needed for any live WhatsApp route

**Business verification (Meta Business Manager → Security Centre)**
- Legal name, address and phone exactly as on the documents; website on a domain the company controls.
- Domain verification for that website, and a business email on the same domain (Meta may verify by email or phone).
- Documents: Certificate of Formation, the EIN letter, and a utility bill or bank statement in the exact legal name
  and address.
- Done by a Business Manager admin. 360dialog does not accept partner-led verification, so Meronatic's own
  verification is required.

**Tech Provider and app review**
- A Meta developer app owned by the verified business, with WhatsApp added.
- App review with screen recordings for `whatsapp_business_management` and `whatsapp_business_messaging`, plus
  access verification.
- Acceptance of Meta's Tech Provider terms, and of the multi-partner solution with 360dialog. That acceptance cannot
  be undone, so check the name and permissions first.
- Embedded Signup v4, set up with the solution id, so customers onboard under the partner's billing.

**What I prepare and what you do**
- I prepare the app review screen recordings and texts from the test build, the website text listed above, and the
  exact field values to enter.
- You and the co-founder submit the documents and complete the checks yourselves in Meta's and Stripe's pages.

Sources: support.stripe.com (US account requirements), docs.stripe.com (payouts, currencies), stripe.com/pricing,
developers.facebook.com (WhatsApp solution providers, multi-partner solutions, pricing), docs.360dialog.com
(Tech Provider program). Read 29 Oct 2026.
