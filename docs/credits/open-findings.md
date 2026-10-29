# Message credits and partner route: the four low findings still open

Updated 29 Oct 2026 after the review of the partner route (migration 0065). Everything High and Medium is fixed.
These four are Low; none can move money or show one company's data to another.

| # | Finding | Impact | Proposed treatment | Status |
| --- | --- | --- | --- | --- |
| L5 | The worker's look-up functions for held credit and automatic top-ups can be called by the application's database role, not only by the worker. Code running inside the API could list other companies' ids, held message ids and which companies are below their top-up threshold. | Low. Ids and yes/no answers only: no names, amounts or message content. No customer request reaches these functions. Every other worker job (quote expiry, promises, webhooks) works the same way. | Before production, run the worker under its own database login and remove these functions from the application role, for all worker jobs at once (one change, about a day with tests). | Accepted for test mode; scheduled before production |
| N7 | Same as L5, for the later worker functions: pending refunds, unconfirmed automatic top-ups, and the partner funding check. | As L5. The funding check returns platform totals only, and since 0065 it refuses to run inside a company's context. | Same change as L5. | Accepted for test mode; scheduled before production |
| P1 | A partner number's sealed API key is not tied to that number. Someone able to write to the database as platform staff could swap two numbers' keys, so one number's messages would go out on another number of the same partner account. | Low. It needs a platform-staff database write, which is already fully trusted; no customer can do it, and 360dialog keys only work for their own number, so a swapped key fails rather than sending wrongly in most set-ups. | Seal the number id with the key and check it when the key is opened. A small change; do it with the first live partner number. | Accepted for test mode; scheduled before the first live number |
| P2 | The 360dialog webhook uses one shared secret header for all numbers and has no time limit, so a captured request could be replayed. | Low. Replayed messages and statuses are already ignored: each message and status is applied once by its WhatsApp id, and charges are once per message. The header is only sent over HTTPS. | Use 360dialog's per-number webhook settings with a separate secret per number, and rotate the secret every quarter. Set up when the partner account exists. | Accepted for test mode; scheduled with the partner account |

Closed in 0064: L6 (ledger rows not tied to a payment) and L8 (partner figures in another currency).
Closed in 0065: the partner route review's H1, H2, M1 to M6 and its other Low points (`design-and-tests.md`).

One behaviour to know about rather than a defect: when many replies are sent at the same moment around a number's
1,000th service message in a month, Meta may charge a few replies that were not held. They are charged on delivery, so
the company's balance can dip slightly below zero; paid sends then stop until a top-up.
