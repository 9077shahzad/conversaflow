# Synthetic pilot examples — three sectors

Everything here is **invented** and marked "(Synthetic)". These examples let us demo, test and rehearse the pilot
without any real company, person or customer data. Actual pilot companies and invitations remain pending the
owner's confirmation; nobody is contacted.

Seed them locally (disposable database) with:

```bash
bash scripts/with-local-services.sh bash -c 'pnpm db:migrate && pnpm build && node apps/api/dist/verification/seed-pilot-examples.js'
```

## The three companies

| | Wadi Al Khair Home Services (Synthetic) | Marsa Residences Management (Synthetic) | Corniche Bay Suites (Synthetic) |
| --- | --- | --- | --- |
| Sector | Facilities and home services | Property management | Hospitality |
| Location, currency | Eastern Province, Saudi Arabia · SAR | Dubai, UAE · AED | Jeddah, Saudi Arabia · SAR |
| Interface language | Arabic | English | Arabic |
| Plan (trial) | Growth | Business | Starter |
| People | Owner, 1 supervisor, 2 agents | Owner, 1 admin, 2 agents, 1 analyst | Owner, 1 agent |
| Branches → teams | Al Khobar → Dispatch desk · Dammam → Field coordinators | Dubai Marina → Tenant services · JVC → Maintenance coordination | Jeddah Corniche → Front office |
| Business hours | Sun–Thu 08:00–20:00, Sat 09:00–17:00 | Mon–Fri 09:00–18:00, Sat 10:00–14:00 | Every day, 24 hours |
| Response targets | First reply 15 min · resolve 8 h | First reply 30 min · resolve 24 h | First reply 5 min · resolve 2 h |
| Holidays | Founding Day 22 Feb 2027 | UAE National Day 2 Dec 2026 | — |
| Pilot seat allowance | 10 (recorded override) | 10 (recorded override) | 10 (recorded override) |

**Finding from building these:** the approved trial caps allow 3 seats, but realistic pilot teams have 4–5 people.
The system's intended answer is a per-company allowance granted by the platform owner, which is recorded in the
company's limits and wins over the trial cap. The seed uses that. For the real pilot, approve the allowance per
company (suggest 10 seats) as part of each invitation.

## Sample customer conversations (for Phase 2 inbox testing)

Customer names and numbers below are fictional. Phone numbers use the reserved fictional ranges and must never be
messaged.

### Facilities and home services — AC repair request (Arabic)

| From | Message |
| --- | --- |
| Customer | السلام عليكم، المكيف في غرفة النوم لا يبرد منذ أمس. |
| Agent | وعليكم السلام، نأسف لذلك. هل يمكنك تزويدنا بالحي ورقم المبنى، والوقت المناسب للزيارة؟ |
| Customer | حي العقربية، مبنى 12. بكرة الصبح إذا ممكن. |
| Agent | تم حجز موعد غدًا بين 9 و11 صباحًا. سيتواصل معك الفني قبل الوصول. رقم الطلب: WK-1042. |

Tests: assignment to Dispatch desk, first-reply timer within 15 minutes, internal note "send senior technician",
template needed if the customer replies after 24 hours.

### Property management — maintenance report outside office hours (English)

| From | Message |
| --- | --- |
| Tenant | Hi, water is leaking under the kitchen sink in unit 1407. |
| Auto-reply (outside hours) | Thanks for your message. Our team is available Mon–Fri 09:00–18:00 and Sat 10:00–14:00. For emergencies call the building security desk. |
| Agent (next morning) | Good morning. A plumber can visit today 11:00–13:00. Please confirm someone will be at home. |
| Tenant | Yes, that works. |

Tests: business hours and holiday handling, assignment to Maintenance coordination, next-day reply needing an approved
**utility** template if more than 24 hours pass.

### Hospitality — guest request during stay (Arabic and English)

| From | Message |
| --- | --- |
| Guest | Hello, can I get a late checkout tomorrow? Room 508. |
| Agent | Good evening. Late checkout until 14:00 is available at no charge. Shall I confirm it? |
| Guest | نعم من فضلك، وشكرًا. |
| Agent | تم التأكيد: المغادرة المتأخرة حتى الساعة 2 ظهرًا. نتمنى لك إقامة سعيدة. |

Tests: mixed-language conversation, 5-minute first-reply target, handover between shifts.

## Template drafts for Meta approval (Phase 2; not submitted)

| Company | Category | Name | English | Arabic |
| --- | --- | --- | --- | --- |
| Wadi Al Khair | Utility | `visit_confirmation` | Your visit is booked for {{1}} between {{2}}. Request number: {{3}}. | تم حجز زيارتك يوم {{1}} بين {{2}}. رقم الطلب: {{3}}. |
| Wadi Al Khair | Utility | `technician_on_way` | Your technician {{1}} is on the way and should arrive in about {{2}} minutes. | الفني {{1}} في الطريق إليك، ومن المتوقع وصوله خلال {{2}} دقيقة تقريبًا. |
| Marsa Residences | Utility | `planned_water_shutoff` | Notice: water will be shut off in {{1}} on {{2}} from {{3}} for planned maintenance. | تنبيه: سيتم قطع المياه في {{1}} يوم {{2}} من الساعة {{3}} لأعمال صيانة مجدولة. |
| Marsa Residences | Utility | `maintenance_follow_up` | We're following up on your request {{1}}. Reply here if the issue is not resolved. | نتابع طلبك رقم {{1}}. يُرجى الرد هنا إذا لم يتم حل المشكلة. |
| Corniche Bay | Utility | `pre_arrival` | Welcome to Corniche Bay Suites. Your booking {{1}} starts on {{2}}. Reply here for any request before you arrive. | أهلًا بك في Corniche Bay Suites. يبدأ حجزك رقم {{1}} يوم {{2}}. يمكنك الرد هنا لأي طلب قبل وصولك. |

Marketing templates are deliberately absent: trials cannot send marketing messages (owner decision), and pilot use is
service and utility only.

## Volumes for testing

| | Wadi Al Khair | Marsa Residences | Corniche Bay |
| --- | --- | --- | --- |
| Conversations per month (assumed) | 1,200 | 800 | 600 |
| Share outside business hours | 25% | 35% | — (24 h) |
| Share needing a template (reply after 24 h) | 10% | 20% | 5% |
