# External dependencies and costs

Checked 20 Oct 2026 from official documentation unless marked **secondary**. "Not verified" means no official
statement was found. Nothing here is purchased, submitted or connected; each item needs the owner's specific approval.

## 1. Meta — WhatsApp Business Platform (Cloud API)

| Topic | What applies now | Effect on ConversaFlow |
| --- | --- | --- |
| Pricing model | Per delivered message since 1 Jul 2025, by category: marketing, utility, authentication (templates); service (free-form, inside the 24-hour window) | Usage ledger per category and market |
| **Change from 1 Oct 2026** | **Service messages are charged** beyond **1,000 free per phone number per month**; utility messages inside an open window are now charged; a payment method was required by 30 Sep 2026. Eligible governments and non-profits keep free service messages until 31 Dec 2027 | Already modelled as a *draft* allowance (migration 0007). Customer-facing estimates must include service messages |
| Free entry point | A conversation started from a Click-to-WhatsApp ad (mobile apps) opens up to **7 days** in which marketing, utility, authentication and service messages are free | A selling point; store referral data (done in slice 1) |
| Volume tiers | Utility and authentication only; per market and category; reset monthly | Rates loaded from Meta's rate card, never hard-coded |
| Saudi Arabia and UAE rates | Each has its own rate line; marketing rose on 1 Oct 2026. Official USD figures could not be read as text. **Secondary** (Gallabox, from 1 Oct 2026): KSA marketing $0.0662, utility/authentication $0.0123; UAE marketing $0.0662, utility/authentication $0.0181 | Verify against Meta's USD rate-card file before any customer-facing estimate |
| Rate changes | Only on the first day of a quarter, with at least a month's notice; SAR and AED billing currencies since 1 Apr 2026 | Rate table carries effective dates (exists) |
| Customer service window | 24 hours from the customer's last message or call; templates outside it | Enforced in slice 1 |
| Templates | Marketing / utility / authentication; utility judged promotional is approved as marketing; recurring recategorisation; pacing holds (error 132015). Review usually within 24 hours; positional parameters {{1}}, {{2}} … in order, not at the start or end, with sample values (template review page, read 21 Oct 2026, undated). Review, quality (GREEN/YELLOW/RED/UNKNOWN) and category changes arrive by webhook with the WABA id as `entry.id` (webhook references, read 21 Oct 2026, undated) | Built locally in slice 3: category, review status, quality and announced category changes are shown; only approved templates can be sent; recovery sync |
| Media | Images JPEG/PNG up to 5 MB; audio AAC/AMR/MP3/M4A/OGG (Opus) up to 16 MB; video MP4/3GP up to 16 MB; documents (PDF, Office, text) up to 100 MB; stickers WebP up to 500 KB. Download links expire after 5 minutes; media ids from webhooks after 7 days (media page, read 21 Oct 2026, undated) | Built locally in slice 3: background download, malware scan, storage per company. Our storage limit (16 MB by default) is lower than Meta's for documents; larger files are recorded as "too large" |
| Messaging limits | Per business portfolio: 250 → 2,000 → 10k → 100k → unlimited unique users per rolling 24 h | Campaign planner must respect the limit |
| Send idempotency | A request-level idempotency key for the send endpoint was **not verified in the sources checked** (21 Oct 2026) | Duplicate protection relies on our own send states and the callback reference (architecture-extension.md); re-check in Meta's messages reference before live sending |
| Webhooks | `X-Hub-Signature-256` HMAC-SHA256 with the app secret over the raw body; retries for up to **7 days**; **duplicates possible; no ordering guarantee**; up to 1,000 updates and 3 MB per delivery | Slice 1 matches this; 3 MB limit set on the webhook route |
| Onboarding | Become a **Tech Provider**: business verification, App Review (two videos), advanced access to `whatsapp_business_messaging` and `whatsapp_business_management`. **Embedded Signup v4 only** (v2/v3 deprecated 15 Oct 2026). Default 10 new customers per rolling 7 days, 200 after verification | **Blocking for live WhatsApp.** Needs the confirmed legal entity (MERONATIC SOLUTIONS GROUP, LLC, pending) |
| Coexistence | WhatsApp Business app and Cloud API on one number; 20 messages/second; no groups or calls on Cloud API. Country list not stated; KSA/UAE not verified | Eases onboarding of small businesses; test in market |
| Flows | Encrypted data-exchange endpoint (RSA-OAEP + AES-GCM), return 421 on decryption failure | Wave 3 |
| Calling | Business-initiated calls unavailable in US, Canada, Egypt, Vietnam, Nigeria. **Saudi Arabia and UAE not mentioned by Meta; respond.io notes "local restrictions" there** | Not verified — behind a feature flag, tested in market first |
| Native in-chat payments | Meta's payments documentation (read 20 Oct 2026) covers India, Brazil and Mexico only | **Not documented for KSA/UAE** in Meta's official pages — plan on payment links / hosted checkout, re-check before Wave 3 |

**Cost to ConversaFlow:** Meta charges each customer directly (customers add their own card during onboarding).
ConversaFlow passes rates through; any markup would be a commercial decision to disclose (BRD §11).

## 2. Instagram and Messenger (Wave 4)

Reply only after the user writes, within 24 hours; a "human agent" tag allows up to 7 days for human replies.
Requires App Review and business verification, Instagram professional accounts.

## 3. Salla and Zid (Wave 3)

| | Salla | Zid |
| --- | --- | --- |
| Authorisation | OAuth; "Easy Mode" required for App Store apps; access token 14 days, refresh token 1 month, **single-use refresh tokens (refresh under a lock)** | OAuth; two tokens (`Authorization` JWT and `X-Manager-Token`); refresh rotates on use |
| Webhooks | Signed (`X-Salla-Signature`); retried 3 times about 5 minutes apart; includes `abandoned.cart`, orders, products, customers | Basic Auth only (no signature documented); includes `abandoned_cart.created/completed`, orders, products |
| Rate limits | 120–720 requests/minute per store by plan | 60 requests/minute per app per store |
| Publishing | Partner portal review; **closer scrutiny for communication and AI apps** | Review checklist: English/Arabic name, Arabic screenshots, video, trial plans, monitored support |
| Fees | Not documented | Not documented |

A native Salla or Zid integration by Wati or respond.io was **not verified in the sources checked** on 20 Oct 2026 (a Zid
connection exists via Zapier for both); the regional player Mottasl lists both natively.

## 4. Payment gateways (Wave 3)

| Gateway | Methods documented | Webhook security | Onboarding | Fees |
| --- | --- | --- | --- | --- |
| Moyasar | mada, Visa, Mastercard, Apple Pay, STC Pay, Google Pay | Secret token you set | Saudi CR or freelance licence and Saudi bank account | Not public |
| Tap Payments | Cards, Apple Pay, mada; marketplace/platform APIs for onboarding merchants | `hashstring` header (HMAC-SHA256 over named fields) | Not verified | Not verified |
| HyperPay | COPYandPAY hosted widget, pay-by-link, tokens | Encrypted webhooks (AES-256-GCM); retries up to 30 days | Not verified | Not verified |

Merchants hold their own gateway accounts; ConversaFlow never stores card details and trusts only signed events and
reconciliation.

## 5. Tax, privacy and law

| Topic | What applies | Status |
| --- | --- | --- |
| ZATCA e-invoicing | Phase 2 in waves since 2023; **Wave 25 covers taxpayers above SAR 187,500 of VAT-subject revenue, due 1 Feb 2027**. B2B invoices cleared in real time; B2C reported within 24 h | Applies to ConversaFlow's own invoices only if the selling entity is VAT-registered in Saudi Arabia. Merchants' invoices are their obligation. A ZATCA-compliant billing provider may be simpler than building it. **Needs tax advice** |
| Saudi PDPL | In force; enforceable since 14 Sep 2024; implementing regulation and transfer regulation published | Transfers abroad allowed with adequacy or safeguards (standard clauses etc.) and a risk assessment; localisation is conditional, not universal. **Needs qualified legal review** before the pilot (including AI providers outside the Kingdom) |

## 6. Other paid or approval-gated items

| Item | Needed for | Cost (planning) | Approval |
| --- | --- | --- | --- |
| GitHub Team (2 seats) | Protected `main`, code-owner review | $4/user/month for the first 12 months (later price to confirm) | Pending (A16) |
| Hosting (pilot) | Engine, database, files, worker, ClamAV | ≈ $340–440/month (provisional, `readiness/hosting-comparison.md`) | Pending |
| AI provider | AI agent and agent assistance (Wave 2) | Usage-based; Meta's own Business Agent is $2 per million tokens | Pending choice |
| Apple / Google developer accounts | Native apps (Wave 4) | Annual fees | Pending |
| Gulf-dialect native reviewers | CF-EXT-010 quality claims | Per hour | Pending |
| External security review | Before pilot | Quotes pending | Pending |

## Sources

Meta: developers.facebook.com/docs/whatsapp/pricing; …/pricing/updates-to-pricing; business-messaging/whatsapp pages
on webhooks, status reference, messaging limits, template categorisation, pacing and quality, opt-in, tech providers,
embedded signup, coexistence, calling and calling pricing, flows endpoint, payments, catalogs (all accessed 20 Oct
2026). Salla: docs.salla.dev (pages modified 9 Jul – 12 Oct 2026). Zid: docs.zid.sa (modified 11 Jun – 19 Oct 2026),
help-partner.zid.sa (13 Jul 2026). Moyasar: docs.moyasar.com; moyasar.com FAQ. Tap: developers.tap.company (≈4 Oct
2026). HyperPay: hyperpay.docs.oppwa.com. ZATCA: zatca.gov.sa roll-out page (1 Sep 2026) and Wave 25 news (24 Jul
2026), detailed guideline v2. PDPL: dgp.sdaia.gov.sa knowledge centre. Secondary: Gallabox rate card; DLA Piper and
CMS PDPL summaries; KPMG (29 Jul 2026).
