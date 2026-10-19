# Pricing and support proposal (draft, annual pricing approval on hold)

Workbook: `ConversaFlow-Pricing-Support-Model.xlsx` (all inputs editable; 132 formulas, recalculated with no errors).
Nothing is published or offered to customers.

## Proposed support offer

| | Starter ($29) | Growth ($79) | Business ($199) | Enterprise (from $499) |
| --- | --- | --- | --- | --- |
| Included support each month | 15 minutes, email, next business day | 45 minutes, email and chat, same business day | 3 hours, priority (see note) | 6 hours, priority |
| Onboarding | Self-service guide; assisted set-up optional, $99 | Paid onboarding, $199 one-off | Paid onboarding, $399 | Paid onboarding, from $799 |
| Extra support | $60 an hour, in 30-minute steps | $60 an hour | $60 an hour | In contract or $60 an hour |

## Is it viable at $40 per support hour?

Growth scale (100 companies), per company per month, annual billing at 10 × monthly:

| Plan | Before the rework | After the rework |
| --- | --- | --- |
| Starter | −$4.05 (−17%) | $7.63 (24%) |
| Growth | −$10.23 (−16%) | $28.27 (31%) |
| Business | $12.35 (7%) | $18.47 (10%) |
| Enterprise | $111.02 (27%) | $123.31 (27%) |

Across the whole mix, the annual-billing margin is about 22% (monthly billing about 32%).

**What this tells us**

- Starter and Growth become viable once support is capped at an allowance, with paid onboarding and paid extra support. Starter breaks even at about $60 per support hour.
- **Business is the new weak point.** Its 3 included hours cost $120 a month at $40 an hour, which leaves 10% on annual billing, and it turns negative above about $45 an hour.
  - Recommendation: cut the Business allowance to 2 hours. That gives about 32% on annual billing and lifts the whole mix to about 30%.
  - The model still shows the current 3 hours until you decide.

Sensitivity to the support cost (annual billing, per company per month, after the rework):

| Plan | $20 | $30 | $40 | $50 | $60 |
| --- | --- | --- | --- | --- | --- |
| Starter | $15.30 | $11.47 | $7.63 | $3.80 | −$0.03 |
| Growth | $51.77 | $40.02 | $28.27 | $16.52 | $4.77 |
| Business (3 h) | $83.47 | $50.97 | $18.47 | −$14.03 | −$46.53 |
| Enterprise | $253.31 | $188.31 | $123.31 | $58.31 | −$6.69 |

## Pilot subsidy and proposed cap

The proposed pilot has no ConversaFlow fee, and each pilot company pays Meta directly. So the subsidy is the full cost of running the pilot for 90 days:

| | 3 companies | 5 companies |
| --- | --- | --- |
| Support time (about 32 hours per company at $40) | $3,874 | $6,457 |
| Hosting (provisional AWS Frankfurt pilot estimate, about 3 months) | $1,306 | $1,306 |
| Other running costs | $44 | $74 |
| **Pilot subsidy** | **$5,224** | **$7,837** |
| **Proposed spending cap** (subsidy plus 15%, rounded up to the next $500) | **$6,500** | **$9,500** |

The subsidy excludes the independent security review (quoted separately), legal drafting and development time.

Proposed control: track pilot spending monthly against the cap. At 80% of the cap, review with you before committing more.

## Assumptions to replace with real figures

- The share of extra time bought as paid support (40%).
- The take-up of Starter's optional onboarding (30%).
- Customer lifetime, used to spread the one-off onboarding fee (24 months).
- Support hours per pilot company.
- Hosting, which stays provisional until a provider is chosen.
