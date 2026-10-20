# Competitive evidence — Wati and respond.io (checked 20 Oct 2026)

Every claim below comes from the vendor's own pages unless marked **third party**. All pages were read on
20 Oct 2026; a page's own date is given where it shows one. "Not verified" means no official statement was found
either way; it does not mean the feature is missing.

Two limits: Wati's pricing page builds its prices in the browser, so its base prices did not come through when
read, and Wati's trust centre (trust.wati.io) could not be opened. Both are listed under "follow-up" at the end.

## 1. Prices and plan limits

### respond.io (official, USD)

| | Starter | Growth | Advanced | Enterprise |
| --- | --- | --- | --- | --- |
| Monthly billing | $99 | $199 | $349 | Custom |
| Annual billing | $948/yr (= $79/mo) | $1,908/yr (= $159/mo) | $3,348/yr (= $279/mo) | Custom |
| Users included / extra user | 5 / $12 | 10 / $20 | 10 / $24 | Unlimited |
| Monthly active contacts | Unlimited | 1,000, then $12 per 100 | 1,000, then $15 per 100 | Custom |
| AI credits | 5,000 | 10,000 | 20,000 | 40,000 |

- Broadcasts, Workflows, AI Agents, Zapier/Make and the developer API start at **Growth**. Webhooks, HTTP steps,
  SSO and custom channels start at **Advanced**.
- AI credits beyond the allowance cost $15 per 1,000, capped at 200% of the plan.
- Monthly or annual, no stated minimum term, 7-day trial. No SAR or regional pricing found.

### Wati (official page; base prices not visible)

| | Growth | Pro | Business |
| --- | --- | --- | --- |
| Users included / extra user | 3 / none | 5 / $24 | 5 / $69 |
| Automation triggers per month | 1,000 | 2,000 | 5,000 |
| AI Co-pilot credits per month | 250 | 500 | 1,500 |
| Integrations | 2 | 5 (incl. HubSpot) | Unlimited (incl. Salesforce) |
| API calls per month | 10k, no webhooks | 200k, limited webhooks | 20M |

- Annual saves "up to 25%". Shopify add-on $4.99/month. Astra AI agents "priced separately".
- **Base prices, third party only:** about $69 / $149 / $349 a month (chatarmin.com, updated 1 Sep 2026; also
  respond.io's comparison blog of 7 Oct 2026). Wati's Arabic pricing page shows different figures ($119 / $179 /
  $423 billed annually) on an older model dated March 2025, so Wati may price by region.

## 2. WhatsApp message fees

| Vendor | What the vendor says | Status |
| --- | --- | --- |
| respond.io | "Passes Meta's rates through unchanged, with no markup" (blogs of 27 Sep and 6 Oct 2026) | **Supported officially** |
| Wati | "Charged based on WATI rate card"; rates shown in the in-app wallet | **Markup not stated officially.** Third parties estimate about 20% on template messages; respond.io's competitor blog claims up to 60% (marketing) and 80% (utility, authentication). Neither figure is verified |

## 3. Features side by side

| Area | Wati | respond.io |
| --- | --- | --- |
| Channels | WhatsApp, Instagram, Messenger, TikTok, web chat (branded widget in beta), SMS, RCS | WhatsApp, Instagram, Messenger, TikTok, web chat, SMS, email, Telegram, Viber, LINE, WeChat, VoIP, custom channels |
| WhatsApp calling | Yes, including the mobile app (June 2026) | Beta (help article 9 Oct 2026); notes "local restrictions" in Saudi Arabia, UAE, Qatar and Egypt |
| Inbox | Assignment, notes, routing rules; round robin and load-based routing on Business and up; working hours; mobile app | Assignment, collaborators, comments, snooze, custom inboxes, mobile app (Starter and up) |
| Collision detection, SLA timers | Not verified | Not verified |
| Flow builder | No-code; up to 200 steps per flow (Wati blog, Oct 2026) | Workflows with branches, waits, HTTP requests (Advanced) |
| AI agents | Astra: end-to-end conversations, voice and voice notes, "30+ languages"; bring-your-own model | AI Agents: documents, web pages, images; actions incl. HTTP, fields, hand-off, calls |
| Agent assistance | Summaries, translation, CX score | AI Assist incl. audio transcription and summaries; translation not verified |
| Campaigns and ads | Segments, scheduling, retargeting; click-to-WhatsApp ads (Meta, TikTok, Google) | Broadcasts (Growth and up); Meta Conversions API; TikTok messaging ads |
| Commerce | WhatsApp catalog; native Shopify; WooCommerce; PayTabs listed; in-chat payments documented for India only (Razorpay, PayU) | Shopify through Zapier; native catalog or checkout not verified in the sources checked |
| **Salla and Zid** | Native integration **not verified in the sources checked**; a Zid connection exists via Zapier | Native integration **not verified in the sources checked**; a Zid connection exists via Zapier |
| CRM | HubSpot (Pro+), Salesforce (Business), Zoho | HubSpot, Salesforce (native) |
| API, webhooks, MCP | API with plan limits; MCP server (docs 29 Sep 2026) | API (Growth+), webhooks (Advanced+); MCP server can configure AI Agents (8 Oct 2026) |
| Arabic interface | App languages: English, Chinese, Spanish, Portuguese (help article 19 Nov 2025). **Arabic UI not listed** | **Arabic UI with full right-to-left switch** (changelog) |
| Arabic AI | Not stated officially beyond a demo label | "Multiple languages"; Arabic not named |
| Security claims | GDPR/CCPA, SOC, ISO 27001 badges; login audit logs; 10 fixed roles; twice-daily backups kept 365 days; **dedicated hosting at $1,000/month with a chosen location** | ISO 27001, GDPR, AES-256 at rest, TLS, AWS multi-data-centre; 2FA; SAML SSO (Advanced+); SOC 2 not claimed; audit trail not verified |
| Saudi or UAE hosting | Not verified (dedicated hosting location "of your choice", regions not listed) | Not verified |
| Gulf presence | Remote team; reseller programme; Kuwaiti agency hosts its Arabic rate card | HQ Kuala Lumpur; Arabic site; no Gulf office named |

## 4. Corrections to the earlier informal comparison

| Earlier claim | Finding |
| --- | --- |
| Wati adds about 60% to marketing messages | **Not verified.** It comes from a competitor's blog; Wati states only that it uses its own rate card |
| respond.io adds no markup | **Supported** by respond.io's own statements |
| Wati has native Shopify; respond.io only through third parties | **Supported** |
| Neither advertises security controls such as audit trails | **Wrong for Wati** (login audit logs, roles, certifications, dedicated hosting). **Partly wrong for respond.io** (ISO 27001, SSO, 2FA; audit trail not verified) |
| Both have only partial Arabic support | **Wrong for respond.io** (full Arabic, right-to-left interface). For Wati, the app's language list does not include Arabic |
| Wati flows up to 200 steps | **Supported** |
| respond.io Starter is $79 or $99 | **Both**: $99 monthly, $79 a month billed annually |

What this means for ConversaFlow's positioning: Arabic interface alone is **not** a differentiator against
respond.io. The defensible advantages are the ones listed in the addendum: Gulf commerce (Salla and Zid, where a native
integration by either competitor was not verified in the sources checked), service operations (the maintenance package), customer-promise
tracking, safe automation, transparent message costs, and company-level security that can be shown (audit trail,
two-person support access). Each still has to be built and proved with pilot customers.

## 5. Other competitors to watch in Saudi Arabia and the UAE (starter list)

| Company | Positioning (from its own site) |
| --- | --- |
| Unifonic | AI customer-experience platform; WhatsApp among several channels; mentions local data residency for regulated GCC sectors |
| Taqnyat | Saudi communications platform (Jeddah, Riyadh, Dammam); Meta-approved WhatsApp partner |
| Mottasl | Arabic-first WhatsApp inbox and chatbots; **native Salla and Zid integrations** |
| SleekFlow | Omnichannel platform; announced UAE market entry |

Mottasl already offers Salla and Zid natively, so ConversaFlow's commerce advantage is against Wati and
respond.io specifically, not against every regional player.

## 6. Follow-up

- Read Wati's live pricing page in a browser for current base prices.
- Wati trust centre: SOC 2 type and certificate dates.
- respond.io: audit log, collision detection and SLA features.
- Whether either vendor offers hosting in Saudi Arabia or the UAE.
- Wati's in-app rate card against Meta's published Saudi and UAE rates, to measure any markup.

## Sources (accessed 20 Oct 2026)

respond.io: respond.io/pricing; respond.io/blog/respondio-pricing (27 Sep 2026); respond.io/blog/whatsapp-pricing-change-2026
(6 Oct 2026); respond.io/blog/wati-vs-respondio (7 Oct 2026, competitor-authored); respond.io/security;
respond.io/help/integrations; respond.io/help/e-commerce-crm-integrations/e-commerce-integration-shopify (9 Oct 2026);
respond.io/help/integrations/model-context-protocol-mcp (8 Oct 2026); respond.io/help/channels;
respond.io/help/whatsapp/whatsapp-business-calling-api (9 Oct 2026); respond.io/help/ai-agent-actions;
respond.io/help/workspace-settings/ai-assist (9 Oct 2026); respond.io/help/workflows; respond.io/help/inbox;
roadmap.respond.io/changelog/arabic-language-is-now-available-in-respondio; respond.io/about.

Wati: wati.io/pricing (metadata 14 Mar 2025); wati.io/ar/pricing (16 Mar 2025); wati.io; wati.io/about-us;
wati.io/en/blog/wati-vs-respond-io-for-growing-businesses (7 Oct 2026, competitor-authored);
support.wati.io articles 11561662 (message pricing), 11463219 (security, 14 Jul 2026), 11463020 (roles, 8 Jun 2026),
11462964 (languages, 19 Nov 2025), 11375155 (overview, 17 Aug 2026), 11463135 (payment gateways), 14270796
(round robin, 8 Sep 2026); feedback.wati.io June 2026 update; docs.wati.io/reference/mcp (29 Sep 2026).

Third party: chatarmin.com/en/blog/wati-pricing (1 Sep 2026); zapier.com app pages for Zid and Salla; bowaba.com Wati
rate card PDF (1 Oct 2026, third-party hosted).

Regional: unifonic.com; taqnyat.sa; mottasl.com; sleekflow.io/news/sleekflow-new-market-uae.
