# ConversaFlow - payment provider comparison (KSA / UAE first)

Prepared 29 Oct 2026 for MERONATIC SOLUTIONS GROUP, LLC (Delaware, USA).
Need: one provider for (a) monthly/annual SaaS subscriptions and (b) prepaid WhatsApp-credit
top-ups (SAR 100 - SAR 50,000, one-off, plus opt-in automatic top-up on a saved card),
with receipts, full/partial refunds, failed-payment handling, disputes, signed webhooks.
Currencies SAR, AED, USD.

Legend: [V] = verified on the cited official page today. [U] = not verified / not published /
needs written confirmation from the provider's sales team. No fee is quoted unless [V].

---------------------------------------------------------------------------------------------

## 1. Bottom line

- Stripe (US account) is the only provider in the list that a Delaware LLC can open on its own
  today and that covers both subscriptions and variable off-session top-ups natively.
- The GCC acquirers (Moyasar, Tap, HyperPay, Checkout.com for mada) all point to a local
  entity: Moyasar states it plainly (Saudi CR + Saudi bank account); Checkout.com says mada
  needs a Saudi merchant ID / Saudi presence; Tap and HyperPay ask for a commercial
  registration and a bank account in the entity's name, and HyperPay prices by registration
  country. None of them is a realistic first account for a US-only entity [U for Tap/HyperPay].
- Paddle is ruled out: its AUP prohibits "stored value" and "Message App marketing" / "SMS
  marketing", which is too close to a WhatsApp-credit product.
- Gap with Stripe: mada is not on Stripe's supported card-brand list, so mada-only debit cards
  will not work; co-badged mada/Visa or mada/Mastercard cards should go through the Visa/MC
  rails [U - test with real KSA cards]. Business buyers mostly pay with corporate Visa/MC.
- Recommendation: start on Stripe US (Billing + PaymentIntents), keep the credit ledger in
  ConversaFlow, and add Moyasar or Tap for mada later, once a Saudi entity (or a Saudi partner
  with a CR) exists. Details in section 5.

---------------------------------------------------------------------------------------------

## 2. Comparison table

| Point | Stripe (US acct) | Paddle (MoR) | Tap Payments | Moyasar | HyperPay | Checkout.com |
|---|---|---|---|---|---|---|
| Delaware LLC can open | Yes - US-registered entity, EIN, SSN/ITIN verification [V] | Seller rules not checked [U] | Needs CR/licence + bank acct in legal name [V]; foreign entity not addressed [U] | No - Saudi CR + Saudi bank acct; "Saudi Arabia only" [V] | Depends on registration country/acquirer [V]; US entity [U] | mada: Saudi merchant ID / Saudi entity [V]; Visa/MC elsewhere [U] |
| Charge SAR / AED | 135+ presentment currencies; AED min 2.00 shown [V]; SAR presentment [U - confirm in Dashboard] | UAE prices auto-converted to USD [V]; SAR/AED not confirmed [U] | mada = SAR only [V]; AED [U] | SAR [U - not stated on FAQ] | [U] | [U] |
| Settlement | USD to US bank; conversion +1% [V] | Payout in USD/EUR/GBP/AUD/CAD balances [V] | Local bank (IBAN) [V] | Saudi bank [V] | [U] | [U] |
| Native subscription engine | Yes - Stripe Billing [V] | Yes - Paddle Billing [V] | No - tokens + merchant-scheduled MIT [V] | Tokens + "billing engine plus APIs"; native engine unclear [V/U] | "Recurring billing", merchant charges token [V] | No billing engine (gateway) [U] |
| One-off variable amount | Yes - PaymentIntents | One-time charges need catalog prices; ad-hoc amount [U] | Yes | Yes | Yes | Yes |
| Same account both | Yes | Yes | Yes | Yes | Yes | Yes |
| Saved card + off-session MIT | Yes - SetupIntent / off_session [V] | Charge on subscription's saved method [V] | Yes - payment agreement, customer_initiated=false, "UNSCHEDULED" contract seen [V]; non-3DS live needs enablement by AM [V] | Tokens, mada tokenisation [V]; MIT without 3DS [U] | Token charge [V] | Recurring supported [V] |
| 3-D Secure | Automatic in Checkout / PaymentIntents [V] | Handled by Paddle [U] | 3DS on CIT [V] | 3DS on first payment [V] | [U] | 3DS required for mada CIT in KSA [V] |
| mada | Not in supported card brands [V]; co-badged via Visa/MC [U] | Listed as supported network [V] | Yes, incl. mada recurring [V] | Yes [V] | Yes [V] | Yes, with Saudi entity [V] |
| Apple Pay | Yes [V] | [U] | Apple Pay recurring docs exist [V] | Yes [V] | Yes [V] | Yes, incl. mada on Apple Pay [V] |
| Published fees | Yes (see 3.1) [V] | 5% + 50c [V] | Not published [U] | Not published - "provided by sales" [V] | Not published - by country [V] | Not published [U] |
| Webhook signing | Stripe-Signature HMAC [U - standard docs, not re-read] | Paddle-Signature [U] | `hashstring` HMAC-SHA256 with secret key [V] | `secret_token` in payload; no HMAC described [V] | [U] | [U] |
| Sandbox | Test mode [U - well known] | Sandbox [U] | Test keys [U] | Sandbox [V] | Test env [U] | Sandbox [U] |
| Stored value / credits in AUP | "Restricted": stored value issued by others; seller-maintained may be limited [V] | Prohibited: "stored value" [V] | [U] | [U] | [U] | [U] |
| VAT help | Stripe Tax: UAE non-resident rule shown [V]; KSA page not loaded [U]; ZATCA not offered [U] | MoR: collects KSA 15% / UAE 5%, B2C only [V] | No [U] | No [U] | No [U] | No [U] |

---------------------------------------------------------------------------------------------

## 3. Provider notes

### 3.1 Stripe (US account under the Delaware LLC)
- Eligibility: "Registered businesses must be registered in the US, even if you operate in
  another country." Stripe verifies EIN, legal name, entity type, business address (no PO box)
  and an SSN or ITIN. https://support.stripe.com/questions/requirements-for-having-a-us-stripe-account [V]
  Whose SSN/ITIN (owner vs representative) for a non-resident owner: [U] - see
  https://support.stripe.com/questions/business-rep-owner-tax-id-requirements-for-us-companies
- A Stripe UAE account exists (Visa, MC, Apple Pay, Google Pay, Link; Billing available) but
  needs a UAE entity. https://support.stripe.com/questions/which-payments-methods-and-products-are-available-in-the-uae [V]
- Currencies: charge in 135+ currencies, settle in USD; AED minimum charge 2.00.
  https://docs.stripe.com/currencies [V]. SAR as presentment currency on a US account: [U].
- Card brands: Visa, Mastercard (all countries), Amex (not for UAE accounts), Discover, JCB,
  UnionPay, Cartes Bancaires, eftpos. mada is not listed. Saving cards / future payments is
  "supported across all card brands". https://docs.stripe.com/payments/cards/supported-card-brands [V]
- Fees (US standard): 2.9% + 30c domestic card; +1.5% international card; +1% currency
  conversion; +0.5% manually entered card; dispute $15 (+$15 if countered, refunded on win);
  Billing 0.7% of billing volume (pay as you go); Stripe Tax 0.5% per transaction (no-code) or
  $0.50 per API transaction; Invoicing Starter 0.4% per paid invoice. No monthly minimum on
  pay-as-you-go. https://stripe.com/pricing [V]
  Worked example (estimate, our arithmetic): KSA corporate card, SAR price, USD payout =
  2.9% + 1.5% + 1% = 5.4% + 30c, plus 0.7% Billing on subscription invoices. A SAR 50,000
  top-up costs roughly SAR 2,700 in fees - large top-ups should also be offered by bank transfer.
- Off-session top-up: save card via SetupIntent / setup_future_usage, then confirm a
  PaymentIntent with off_session=true; handle `authentication_required` by emailing the
  customer a link to authenticate. https://docs.stripe.com/payments/save-and-reuse [page index V; detail U]
- Prepaid credits: Stripe Billing "credit grants" exist but apply only to metered subscription
  items, cannot be stored value, cannot pay third parties, cannot be linked to wallets.
  https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits [V]
  -> For one-off top-ups, keep our own credit ledger and use plain PaymentIntents.
- AUP: "Sale of stored value or credits maintained, accepted, and issued by anyone other than
  the seller" is restricted; "Preloaded payment cards, gift cards, virtual credits" restricted;
  SMS/messaging not listed. https://stripe.com/legal/restricted-businesses [V]
  ConversaFlow credits are issued and used only by ConversaFlow for its own service -> describe
  them as "prepaid usage of the ConversaFlow platform" (non-transferable, non-cash) during
  onboarding, and get written confirmation [U].
- Tax: Stripe Tax UAE page - non-resident must register from the first taxable B2C sale (within
  30 days); B2B to UAE businesses is reverse charge, no registration needed for B2B-only.
  https://docs.stripe.com/tax/supported-countries/europe-middle-east-and-africa/united-arab-emirates [V]
  KSA page (https://docs.stripe.com/tax/supported-countries/asia-pacific/saudi-arabia) could
  not be loaded [U]. ZATCA e-invoicing (Fatoorah) integration by Stripe: not found [U].
- Stripe Managed Payments (Stripe as merchant of record): US sellers eligible, SaaS / AIaaS tax
  codes eligible, SA covered for cross-border tax, AE not in the covered list.
  https://docs.stripe.com/payments/managed-payments/eligibility and .../tax-coverage [V]
  Fees and treatment of prepaid credits under Managed Payments: [U]. Worth asking Stripe.

### 3.2 Paddle (merchant of record)
- Pricing 5% + 50c per checkout transaction, tax, fraud, chargebacks and buyer support
  included; transactions under $10 may need bespoke pricing. https://www.paddle.com/pricing [V]
- Tax: charges KSA 15% and UAE 5% VAT, B2C only.
  https://paddle.com/help/sell/tax/which-countries-does-paddle-charge-sales-tax-or-vat-for/ [V]
- mada listed as a supported card network. https://developer.paddle.com/reference/payment-methods/cards [V]
- One-time charges on a subscription bill the saved method immediately, but only catalog
  prices (billing_cycle null). https://developer.paddle.com/build/subscriptions/bill-add-one-time-charge [V]
- AUP blockers: prohibits "Virtual currency or stored value, including ... store credit, gift
  cards, vouchers"; "Mass Marketing Products, including ... SMS marketing and Message App
  marketing"; "Phone services"; marketplaces.
  https://paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle [V]
- Verdict: not suitable for WhatsApp message credits. Would only fit the plain SaaS seat
  subscription, and even then the "Message App" wording is a risk.

### 3.3 Tap Payments
- Onboarding documents: commercial licence/registration, MoA, VAT certificate, signatory and
  20%+ owner IDs (passport for foreigners), IBAN certificate with English account name matching
  the legal name, live website with T&Cs and refund policy.
  https://support.tap.company/en/support/solutions/articles/153000242639 [V]
  Whether a US LLC can be onboarded without a GCC entity: [U].
- mada SAR only. https://developers.tap.company/docs/mada [V]
- mada recurring: save_card=true, then MIT with customer_initiated=false and payment agreement
  ID. https://developers.tap.company/docs/mada-recurring [V]
- MIT: 3DS off for MIT; non-3DS live needs account-manager enablement; sample shows contract
  type "UNSCHEDULED" and a variable_amount object.
  https://developers.tap.company/docs/merchant-initiated-transaction [V]
- No native subscription engine - "you must schedule each charge yourself"; tokens are
  one-time and expire after 5 minutes. https://developers.tap.company/docs/recurring-payments [V]
- Webhooks: `hashstring` header, HMAC-SHA256 over listed fields with the secret key.
  https://developers.tap.company/docs/webhook [V]
- Fees: not published on the official site (pricing page did not load) [U].

### 3.4 Moyasar
- "You need a valid Saudi commercial registration (CR) or freelance license, and a Saudi
  commercial bank account linked to it"; focuses on Saudi Arabia only. Pricing from sales.
  mada refunds 24 h - 3 business days, credit cards 7 - 14 business days. mada, Apple Pay,
  Samsung Pay supported. https://www.moyasar.com/en/resources/faqs [V]
- Tokenisation supports mada, Visa, MC, Amex, UnionPay; token usable once `active`.
  https://docs.moyasar.com/guides/tokenization/overview [V]
- SaaS page mentions saved tokens, scheduled charges, retries, webhooks, but whether the
  billing engine is Moyasar's is unclear. https://moyasar.com/en/solutions/subscriptions-and-saas/ [V/U]
- Webhooks: events payment_paid, payment_failed, payment_refunded, payment_voided, etc.;
  security = `secret_token` set by you, no HMAC described. https://docs.moyasar.com/webhook-reference [V]
- Verdict: good mada/Apple Pay option later, only with a Saudi CR.

### 3.5 HyperPay
- Riyadh-based, SAMA-licensed; mada, Apple Pay, Visa; documents and pricing depend on the
  company's registration country and acquiring bank; pricing via bd@hyperpay.com.
  https://www.hyperpay.com/ [V]
- Recurring billing: card tokenised, merchant charges the token on the due date.
  https://www.hyperpay.com/billing/ [V]
- Fees, webhook signing, foreign-entity eligibility: [U].

### 3.6 Checkout.com (added for mada/enterprise)
- mada: Saudi Arabia only as merchant/business country; "a direct contract with a local
  provider is required"; recurring and mada on Apple Pay supported.
  https://www.checkout.com/payment-methods/accept/mada [V]
- mada needs "a merchant ID from a Saudi Arabian card acquirer"; full capture only; 3DS + CVV
  required on KSA CITs. https://www.checkout.com/docs/payments/add-payment-methods/mada [V]
- Pricing not published; generally enterprise-volume oriented [U]. Not a first choice.

---------------------------------------------------------------------------------------------

## 4. Tax: what stays with Meronatic
- With any non-MoR provider (Stripe, Tap, Moyasar, HyperPay, Checkout.com), VAT invoicing is
  ours. Stripe Tax can calculate and put VAT on invoices; it does not file in KSA/UAE by itself
  (third-party partners mentioned for filing) [V for UAE page; KSA U].
- B2B position (most ConversaFlow customers are companies): UAE B2B sales are reverse charge
  per Stripe's UAE page [V]. KSA B2B from a non-resident is commonly reverse charge by the Saudi
  buyer - confirm with a KSA tax adviser [U]. Collect each customer's VAT/TRN number at signup.
- ZATCA e-invoicing: a non-resident without a permanent establishment is "generally exempt"
  from direct Phase 2 e-invoicing, but a VAT-registered non-resident sits in a grey zone
  (secondary source: https://www.wafeq.com/en-sa/tax-and-reporting/saudi-arabia-e-invoicing-fatoorah-what-foreign-businesses-need-to-know) [U].
  None of the providers above was found to issue ZATCA-cleared invoices.
- Any B2C or sole-trader buyers in the UAE would trigger UAE registration from the first sale
  [V Stripe UAE page] - simplest is to sell B2B only and require a TRN/CR at signup.

---------------------------------------------------------------------------------------------

## 5. Recommendation

Phase 1 (now): Stripe US account under MERONATIC SOLUTIONS GROUP, LLC.
- Subscriptions: Stripe Billing (Checkout or Payment Element, Customer Portal, Smart Retries /
  dunning emails, invoices and receipts). Prices in SAR, AED and USD.
- Top-ups: Checkout Session / PaymentIntent with setup_future_usage=off_session, amount set by
  the customer within SAR 100 - 50,000. Credits are written to ConversaFlow's own ledger on the
  `payment_intent.succeeded` / `checkout.session.completed` webhook (verify Stripe-Signature).
- Auto top-up: explicit opt-in screen (threshold, amount, monthly cap, mandate text), then
  off-session PaymentIntent; on `authentication_required` or decline, switch auto top-up off,
  email/WhatsApp a pay link, and alert the tenant admin.
- Refunds: full/partial via Refund API; reverse unspent credits in the ledger only.
- Disputes: `charge.dispute.created` freezes the tenant's remaining credits; budget $15/dispute.
- Large top-ups (e.g. above SAR 10,000): offer bank transfer against a proforma invoice to
  avoid ~5-6% card cost [our suggestion].
- Why: only option a Delaware LLC can open alone; native subscriptions + variable MIT in one
  account; published pricing; mature webhooks and test mode.
- Trade-off: no mada-only cards; higher cross-border cost; USD settlement.

Phase 2 (when a Saudi entity / CR exists, e.g. via a Musanadah-style local partner or a new
KSA branch): add Moyasar or Tap as a second processor for mada and Apple Pay-mada top-ups in SAR,
keeping Stripe for subscriptions. Tap has the better documented MIT / payment-agreement model
for auto top-up [V]; Moyasar has the clearer onboarding rules [V]. Get quotes from both.

Not recommended: Paddle (AUP: stored value and Message App marketing prohibited);
Checkout.com (enterprise, mada needs Saudi entity); HyperPay as a first account (no public
pricing, country-dependent onboarding).

---------------------------------------------------------------------------------------------

## 6. What Meronatic must do to open Stripe
1. Have ready: Delaware certificate of formation, EIN letter (IRS CP575/147C), operating
   agreement, registered/business address (not a PO box), US phone number.
2. Representative and 25%+ owners: passport, date of birth, address; SSN or ITIN where Stripe
   asks for it - apply for an ITIN early if Muhammad has none [U which person needs it].
3. US business bank account in the LLC's name for USD payouts.
4. Live ConversaFlow website: pricing in SAR/AED/USD, Terms, Privacy, Refund & Cancellation
   policy, a prepaid-credit policy (non-transferable, non-cash, expiry rule, refund rule for
   unused credit), auto top-up terms, support email/phone, company legal name and address.
5. Describe the business accurately at onboarding: "B2B SaaS for WhatsApp customer messaging;
   customers prepay usage credits consumed only on our platform". Expect a restricted-business
   review; ask Stripe support for written OK on prepaid credits.
6. Confirm in the Dashboard that SAR and AED are enabled presentment currencies, and test with
   real Saudi co-badged mada/Visa and mada/Mastercard cards in live mode with small amounts.
7. Enable Stripe Tax (or decide not to), set up customer tax ID collection (KSA VAT / UAE TRN),
   and take advice on KSA reverse charge and ZATCA position.
8. Build webhooks with signature checks, idempotency keys, and a credit ledger; finish test
   mode scenarios (3DS challenge, decline, insufficient funds, dispute, partial refund).
9. Ask Stripe whether Managed Payments (Stripe as MoR) would accept the subscription part,
   since it covers SA cross-border tax [V], and what it costs [U].
