# ConversaFlow: WhatsApp Solution Partner comparison (multi-partner solution)

Prepared 29 Oct 2026 for MERONATIC SOLUTIONS GROUP, LLC (Delaware). Web research only, using vendor and Meta pages read on this date.
"Unverified" means the vendor's public pages did not confirm the point. Where a price is not published it says "contact sales". No prices are estimated.

## 0. What Meta's own rules mean for all four

- Tech Providers have no credit line of their own. Their clients normally add a payment method and Meta bills them directly. In a Multi-Partner Solution (MPS), the Solution Partner "can share their credit line with clients onboarded via your joint solution". Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview/
- Clients onboarded through an Embedded Signup set up for the solution (`extras.setup.solutionID`) "share the credit line of the Solution Partner", and "access to those assets is granted to both partners". Limit: 200 new clients per rolling week. Once accepted, a solution "cannot be declined". Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/multi-partner-solutions.md
- When the solution is created, Meta asks who may send messages: "Only me" or "Only my partner". **All four vendors below require "Only my partner"**, or make you send through their API. In practice, ConversaFlow cannot keep sending straight to graph.facebook.com for clients covered by the partner's credit line. Template and WABA management can still use the Graph API, depending on the permissions granted.
- Exit route: Meta supports moving a client to another MPS, or off the MPS entirely so ConversaFlow serves it alone. The client unshares the WABA and re-runs Embedded Signup with the same number, with no number re-verification. Templates are copied with the Template Migration API (APPROVED and GREEN only). Messages delivered before the cutover are billed to the old partner. Sources: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/support/migrating-customers-off-solutions-via-embedded-signup and https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/support/migrating-wabas-among-solutions-via-embedded-signup

## 1. Comparison table

| Topic | 360dialog | Twilio | Infobip | Gupshup |
|---|---|---|---|---|
| MPS with our own Embedded Signup | Yes. Partner-hosted Embedded Signup needs a Meta-approved Tech Provider with an ACTIVE solution. 360dialog approves within about 24h. | Yes. Twilio creates the Partner Solution from a support ticket, and we embed Embedded Signup v4 with its solutionID. | Yes. We create the solution with Infobip app ID 1370401139746733, and our account manager has to push the approval. | Yes, but partner-hosted Embedded Signup is "beta, select partners only". |
| Credit line or consolidated bill | Partner-Paid model: one shared balance and "partner-level invoices". The balance is **prepaid** (top-ups, auto-recharge). Messaging pauses at zero. | Meta bills Twilio. All subaccount usage "billed to your main account". Prepaid by card, or invoiced net 30 under a written agreement (ToS 3.3). | "Clients share Infobip's credit line"; Infobip "charges the solution to you". Prepaid or postpaid terms: unverified. | Credit line attached per WABA on app link. Partner USD wallet, prepaid ($10 to $10,000 per top-up). |
| Resale or markup to our clients | Allowed: under Partner-Paid "the partner manages client billing and sets its own commercial terms". | Allowed only inside our own service to our End Users (ToS 2.2(b) bars plain resale). | "You can bill your clients directly for your value-added solution". | Not stated explicitly (unverified). There is a partner commission scheme. |
| Platform fee | Partner Plan per month: Starter €250/$300 (5 channels), Growth €500/$600 (10), Premium €1,000/$1,200 (20) | None listed | Contact sales | None listed on the self-serve page |
| Per-number fee | Extra channel per month: €49/$59 (Starter), €25/$30 (Growth), €15/$18 (Premium). Premium channel adds €50/$60. | None listed (sender number costs, if Twilio supplies it: unverified) | Contact sales | None listed |
| Per-message markup | Meta rate card passed through. +7% on marketing sent via /messages instead of the Marketing Messages API. | +$0.005 per message, inbound or outbound, plus Meta fees passed through. $0.001 per failed message. | Contact sales ("customizable pricing") | +$0.001 per message (template and session). +6% on Cloud API marketing from 1 Jan 2026. |
| Setup fee, minimum, deposit | Not stated. Partner Plan has a monthly minimum; cancellation takes effect "30 days to the end of the month". | None listed. Card payment not accepted above $8,000 per month. | Contact sales | None listed. $10 minimum top-up. |
| Currency | EUR or USD, chosen at onboarding. 4% card fee. | USD | EUR or USD (calculator) | USD |
| Billing entity | Not named on billing page (German VAT rules point to a German entity: unverified). No VAT outside the EU. | Twilio Inc., San Francisco, for non-EEA customers | Unverified | Gupshup Technology Gulf Limited (KSA local arm, per Gupshup press release). Contracting entity for us: unverified. |
| Middle East presence | Unverified | Unverified | KSA operations and a KSA data centre (press, 2024) | Dubai presence, KSA launch Oct 2024 (Gupshup release) |
| Support SLA | "SLAs depend on license fee plan or Partner Solution plan". Figures unverified. | Published: Production greater of $250 or 4% of spend (3 business hours critical); Business $1,500 or 6% (1h, 24/7); Personalized $5,000 or 8% | Unverified, contact sales | Unverified |
| Exit and lock-in | Settle invoices, disable 2FA, new BSP starts migration, refund of unused funds on request. 360dialog says the choice "does not prevent... moving away". | ToS: either party may end it for convenience on 30 days' notice. Outbound number migration: not documented. | Inbound migration documented. Outbound: unverified. | Not documented (unverified) |
| API path | Own endpoint `https://waba-v2.360dialog.io` with header `D360-API-KEY`. Request body uses Cloud API schema (`messaging_product: "whatsapp"`). | Twilio Messages and Senders API, one subaccount per WABA. "Your application won't need to call any Meta APIs". | Infobip WhatsApp API (`api.infobip.com`). "Only my partner" sends. | Gupshup Partner API. Optional "passthrough" API that "imitates the Meta send message format". |

## 2. Vendor notes

### 360dialog
- Tech Provider route: https://docs.360dialog.com/partner/get-started/tech-providers and https://docs.360dialog.com/partner/get-started/tech-provider-program/tech-provider-program-info
  - "Tech Providers can host their own embedded sign-up". The MPS needs 360dialog approval and "can't be combined with other BSPs".
  - Onboarding more than 3 numbers needs Meta Tech Provider registration.
- Solution creation: https://docs.360dialog.com/partner/integration/integrated-onboarding/host-your-own-embedded-signup/creating-partner-solution
  - Send Messages = "Only my partner" ("Inform Meta you'll use 360Dialog API to send messages"). Partner App ID 307713669880953.
  - Partner-led business verification (PLBV) is not accepted, so Meronatic's own Meta business verification is needed.
  - Quote: "it is always possible to switch Solution Partners or operate independently at a later date."
- Partner-hosted Embedded Signup: https://docs.360dialog.com/partner/onboarding/partner-hosted-embedded-signup.md
  - 360dialog registers the phone. We call the Partner API (create client, then share numbers), wait for the Channel Live webhook, then generate an API key per channel.
  - 360dialog gives no support for custom Embedded Signup scripts.
- Pricing: https://docs.360dialog.com/partner/get-started/pricing.md
  - Optional higher throughput €249/$299 per month.
- Billing models: https://docs.360dialog.com/partner/get-started/billing-models.md
  - Direct-Paid gives each channel its own prepaid balance and invoices go to the client. Not what we want.
  - Partner-Paid gives one shared balance and consolidated invoices. This is our model.
- Funds and billing: https://docs.360dialog.com/partner/partner-hub/funds.md and https://docs.360dialog.com/partner/partner-hub/billing.md
  - Usage is deducted "in real time" and "outbound messaging and calls are paused" at zero balance.
  - Postpaid or credit terms are not published (unverified).
- Migration out: https://docs.360dialog.com/partner/partner-hub/migrating-phone-numbers/migrate-to-alternate-bsp
  - No minimum term or exit fee is mentioned; check the contract.
- API: https://docs.360dialog.com/the-basics and https://docs.360dialog.com/guides/send-and-receive-messages
  - Whether the webhook payload exactly matches Meta's is unverified.

### Twilio
- Program and setup: https://www.twilio.com/docs/whatsapp/isv/tech-provider-program and https://www.twilio.com/docs/whatsapp/isv/tech-provider-program/integration-guide
  - "Every customer WABA needs to be connected to a separate Twilio subaccount."
  - Meta's notice that the client works with Twilio "can't be removed" from Embedded Signup.
  - Meta setup and partner linking take "3-4 weeks".
- FAQ: https://www.twilio.com/docs/whatsapp/isv/tech-provider-program/faq
  - The program is free. "Meta bills Twilio... Meta doesn't bill ISVs directly."
  - Bringing an existing number from another BSP needs a new WABA for Twilio.
- Pricing: https://www.twilio.com/en-us/whatsapp/pricing
  - Saudi and UAE Meta template rates were not shown on that page. Use Meta's rate card.
- Billing and terms: https://www.twilio.com/docs/iam/api/subaccounts.md (subaccount usage billed to the main account; up to 1,000 subaccounts by default) and https://www.twilio.com/en-us/legal/tos (Twilio Inc.; USD; net 30 by invoice; 30-day termination for convenience).
- Support plans: https://www.twilio.com/en-us/support-plans
- Fit: worst for our codebase. Twilio's message format and webhooks differ from Cloud API, so we would need a full adapter and to keep subaccount credentials for each tenant.

### Infobip
- Program and setup: https://www.infobip.com/docs/whatsapp/tech-provider-program.md and https://www.infobip.com/docs/whatsapp/tech-provider-program/setup-and-integration.md
  - Send messages = "Only my partner".
  - Login configuration needs Cloud API and Marketing Messages API products, with token expiry set to Never.
  - After Embedded Signup we call `POST /whatsapp/1/embedded-signup/registrations/share-waba` on `https://api.infobip.com`.
  - Quote: "Infobip does not automatically review partner solution requests". An account manager is needed.
- Pricing: https://www.infobip.com/whatsapp-business/pricing. Pay-as-you-go per message, EUR or USD. Actual figures are contact sales.
- Migration: https://infobip.com/docs/whatsapp/get-started/migrate-phone-number covers moving in only. Moving out is unverified.
- KSA presence: Infobip KSA operations and data centre. This is third-party press, not a vendor page: https://zawya.com/en/press-release/companies-news/infobip-secures-sms-license-in-saudi-arabia-establishing-full-connectivity-across-the-kingdom-gcktigri

### Gupshup
- Roles and solution setup: https://partner-docs.gupshup.io/docs/what-is-sp-tp and https://partner-docs.gupshup.io/docs/get-solution-id-from-meta
  - "ONLY MY PARTNER" is mandatory, or Gupshup rejects the solution, and the choice is non-editable.
  - Each app must be linked to our partner ID before going live.
- Partner-hosted Embedded Signup: https://partner-docs.gupshup.io/docs/partner-hosted-onboarding
  - Beta. The App Linking API "attaches the Gupshup credit line to the WABA". We must not register the number or set 2FA ourselves.
- Pricing: https://www.gupshup.ai/isv-partners/whatsapp-api/pricing (USD; $0.001 per message; Meta "billed at actuals") and https://support.gupshup.io/hc/en-us/articles/53700207494169-Gupshup-fee-changes-to-Cloud-API-marketing-w-e-f-1st-Jan-2026 (6% marketing markup).
  - The pricing page also says Meta charges for service messages from 1 Oct 2026. That claim was not checked on Meta's own pages.
- Wallet: https://support.gupshup.io/hc/en-us/articles/33760266293529-Basics-of-Gupshup-Wallet-and-Billing-for-Prepaid-USD-Wallet
  - Prepaid USD. Stripe or Ebanx. Credits "non-transferable and non-refundable" (https://docs.gupshup.io/docs/wallet).
- Passthrough API in Meta format: https://partner-docs.gupshup.io/docs/meta-passthrough-apis
  - Needs v3 callback subscriptions. Base URL and auth: unverified.
- Gulf presence: https://www.gupshup.ai/resources/?p=26152 (KSA launch, 21 Oct 2024, via Gupshup Technology Gulf Limited; Dubai presence; GCC is its "third-largest market").

## 3. Rough fixed-cost picture (published prices only; Meta fees excluded)

Meta's own per-message rates for Saudi Arabia and the UAE are the same with every partner. Only the partner's own fees differ.

- **360dialog, 50 client numbers:** Growth plan €500 plus 40 extra channels × €25 = **€1,500 per month**, with no per-message markup apart from the 7% marketing surcharge if the Marketing Messages API is not used.
- **360dialog, 20 numbers:** Premium plan €1,000, or Growth €500 plus 10 × €25 = €750 per month.
- **Twilio, 1M messages per month:** $5,000 per month in Twilio fees, plus a support plan if an SLA is needed.
- **Gupshup, 1M messages per month:** $1,000 per month in Gupshup fees.
- **Infobip:** contact sales.

When it is cheaper: 360dialog wins when clients send many messages per number. Gupshup is cheaper while each client sends little.

## 4. Recommendation: 360dialog

1. **Billing fits the model.** 360dialog's documented Partner-Paid model is exactly what we want: one shared balance across all client channels, partner-level consolidated invoices, and freedom to set our own client pricing. Meta's per-message rates pass through with no hidden markup.
2. **Prices are published.** Costs can go into the ConversaFlow plan now. Infobip is contact sales; Twilio's $0.005 per message is 5 times Gupshup's fee and grows with volume.
3. **Least code change.** The send body is the Cloud API schema. Our Meta-targeted code changes mainly in base URL and auth header (`graph.facebook.com/{phone_id}/messages` with a Bearer token becomes `waba-v2.360dialog.io/messages` with `D360-API-KEY`). Twilio needs a full rewrite. Infobip and Gupshup need their own adapters or a beta passthrough API.
4. **Partner-hosted Embedded Signup is generally available**, not beta as at Gupshup. 360dialog also states in writing that switching partners or going independent later remains possible, which matches Meta's migrate-off-solution flow.

**Trade-offs we would accept:**
- The balance is prepaid, not true postpaid credit. Meronatic carries the float, so client prepaid balances must be collected before the shared balance is topped up.
- There are per-channel licence fees.
- Middle East presence and SLA figures are unverified.

**Fallback:** If Saudi local presence, data residency or SAR invoicing becomes a hard requirement (for example, government or enterprise clients), get a quote from Infobip as the alternative.

## 5. Questions for 360dialog sales before committing

1. Can a Partner-Paid account get a postpaid credit limit or net terms instead of a prepaid shared balance? What happens to client traffic at zero balance, and can we set per-client sub-limits or alerts?
2. Contracting entity, invoice currency (USD vs EUR), VAT or withholding treatment for a Delaware LLC billing clients in Saudi Arabia and the UAE. Can invoices show a per-client (per-channel) breakdown we can use for re-billing?
3. Exact SLA, response times and support hours for each Partner Plan. Is there Arabic-language or Gulf time-zone support?
4. Confirm that with "Only my partner" we can still call the Graph API for template and WABA management, and that webhooks arrive in Meta's Cloud API format.
5. Minimum term, notice and exit fees on the Partner Plan and channel licences. Will 360dialog cooperate with Meta's "migrate off solution" flow if we become a Solution Partner or switch BSP (2FA, unused funds refund, time to release)?
6. Is the MPS limit of 200 clients per week and any 360dialog throughput cap enough for our launch? What does the €249 higher-throughput add-on actually give?
7. Do Saudi (+966) and UAE (+971) numbers and businesses have any onboarding, verification or sender restrictions? Are any categories (for example, finance or health) blocked?
8. Are volume discounts available on channel fees above 20 channels, or on the Meta marketing surcharge?
9. Does the policy for a reseller using Partner-Paid require us to show 360dialog or Meta terms to our clients?

## 6. What Meronatic must sign or accept

- **Meta:** Meta Business verification of Meronatic's business portfolio (360dialog does not accept PLBV), WhatsApp Business Platform terms, and Meta Tech Provider terms (https://www.facebook.com/legal/BM-tech-provider-terms). Also App Review for `whatsapp_business_management` and `whatsapp_business_messaging`, plus Access Verification.
- **Partner solution:** Acceptance of the Partner Solution in the App Dashboard. This cannot be declined later, so check name and permissions first.
- **360dialog:** 360dialog Partner Agreement and Terms, choosing the Partner-Paid billing model, a Partner Plan subscription, a DPA/GDPR agreement (360dialog is EU-based; DPA availability unverified), and a payment method or bank-transfer set-up.
- **Our own client contracts:** ConversaFlow's own terms with clients, covering prepaid message credits, margin, refunds, and passing through Meta's WhatsApp Business Messaging and Commerce policies.
