# Interactive dashboards: test-mode preview

Owner request of 30 Oct 2026. Not published: the preview runs locally in test mode with sandbox WhatsApp numbers.
Production payments and prepaid messaging stay disabled; none of the billing safeguards changed.

## What was built

**Insights (company dashboard)**, `/{locale}/app/insights`, for anyone with `reports.read`:
- Messages in and out, delivery, read and failure rates, conversations started and replied to, median first reply
  and resolved conversations. Each figure is compared with the period just before.
- Daily volumes and delivery, response-time groups, and team performance.
- Message credit balance and spend by message type (prepaid companies, and only with `billing.read`).
- Activity by destination country and WhatsApp number: 3D bars (Three.js), with a heat-map table as the standard
  chart.
- Date filters, comparison with the period before, clickable charts, and a drill-down to the messages behind any
  figure.

**Platform overview**, `/{locale}/app/platform`, for platform owners only:
- Active companies, subscription value, and messaging revenue, cost and margin by day and by company.
- Customer payments and unspent customer credit, kept separate from partner funding.
- Reconciliation alerts and payments that could not be applied.

## Rules kept

- **Company isolation:**
  - Every company figure is read in the company's own row-security context.
  - The platform figures come from one token-bound function (`platform_dashboard`, migration 0066) that only a
    platform owner can run.
- **Permissions:**
  - Agents cannot open Insights.
  - Credit figures need `billing.read`, and team names need `members.read`.
  - The drill-down follows the inbox rule: without "see all conversations", it lists only the person's own or
    unassigned conversations and says how many were left out.
- **No content:** no message text, customer names or numbers leave the server. The country is worked out from the
  calling code on the server.
- **Real data, labelled:**
  - The page says whether the period's messages went through sandbox (test) numbers, live numbers or both.
  - Sample history from the demo seed is marked as sample data.
  - Metrics that are not available (customer satisfaction, revenue from conversations, WhatsApp cost for companies
    that pay Meta directly) are stated as unavailable, not shown as zero.
- **3D only for activity:** money is shown only in standard charts and tables.
- **Accessibility:**
  - English and Arabic, with time running left to right in both.
  - Phone layouts, keyboard use and reduced motion are supported.
  - Every chart can also be shown as a table.
  - In 3D: arrow keys move between bars, Enter opens the drill-down, Q and E turn the view, and plus and minus zoom.
- **Three.js loads only when needed:** it is loaded only when the 3D view opens (a separate 363 KB file; the Insights
  page itself is 26 KB).
- **Fallback:** the standard chart is used when the device has no WebGL, has few cores or little memory, saves data,
  or cannot draw smoothly.

## Independent review

Two rounds by a separate reviewer who read the code only.

- **First round (on 0c7c57e and 6d5fb0e):** 1 High and 5 Medium issues. All are fixed in 46c8a92:
  - the dashboards read the whole message table;
  - amounts in currencies with 3 decimal places showed 10 times too high;
  - the country drill-down was cut off;
  - first reply was counted differently from the Outcomes report;
  - WebGL contexts were not released;
  - the demo seed had weak safety checks.
- **Recheck (on 46c8a92):** 0 High and 2 Medium issues. Both are fixed in 07d5382:
  - the seed checked only some database connections;
  - the chart's "Other" group did not match its drill-down.

**Still open (low):**
1. Migration 0067 builds two indexes without `CONCURRENTLY`. On a large live table this briefly blocks new messages;
   build them concurrently during a quiet period before production.
2. First reply excludes failed replies and has no time window, while the Outcomes report counts failed replies and
   uses the attribution window.
3. The platform page's "Test mode" notice relies on `paymentsLive`, which is fixed at false. That is correct today
   because only Stripe test keys are accepted. It must be linked to the real setting before payments go live.
4. The country of a number is matched by calling-code prefix. That is correct for the current list, but adding a
   code that overlaps another (for example 1876 inside 1) would need a change.
5. The Insights link is still shown to agents; the page and the API refuse them.
6. A message whose delivery is unconfirmed ("uncertain") counts in the delivery-rate base and under "pending".
7. The database allows a 367-day platform period; the API limits it to 366.

## Validation

See "Test evidence" in `docs/credits/design-and-tests.md` for the exact commit and results.
