# Customer journeys

Each journey names who is involved, the steps, what can go wrong, and which requirements and acceptance items it
exercises. These are the journeys the pilots will be judged on, so features are built to complete them end to end.

## J1. A customer asks a question on WhatsApp and gets an answer (Wave 1)

**People:** customer, agent, supervisor.
1. The customer writes "Do you service AC units in Dammam?" (Arabic, English or mixed).
2. ConversaFlow records it once, even if WhatsApp delivers it twice, creates or finds the contact by phone number,
   and shows it as unassigned in the inbox.
3. An agent opens it and replies. Replying claims the conversation; other agents stop seeing it.
4. The customer sees the reply; delivery and read ticks appear as WhatsApp reports them, in any order.

**What can go wrong and what happens:**
- Two agents answer at once → only one reply is sent; the other is told the conversation changed.
- The customer writes again while the agent types → the agent is told to read the new message first.
- The agent replies after 24 hours → refused; only an approved template may be sent.
- WhatsApp refuses the send → the message shows "failed" with the provider's reason, never "sent".

**Requirements:** CF-EXT-001, 002, 003; FR-101–106, FR-201–204. **Acceptance:** 1, 2, 7. **Status:** API built and
tested locally (slice 1); inbox screen next.

## J2. A customer opts out (Wave 1)

1. The customer sends "STOP" or "إيقاف".
2. The contact is marked opted out, with the message as evidence; the conversation history shows it; the audit log
   records it.
3. Any reply, template or campaign to that contact is refused until the customer sends "START" or "ابدأ".

**Requirements:** CF-EXT-001, 004; FR-108. **Acceptance:** 6. **Status:** replies built and tested; campaigns and
templates will reuse the same check.

## J3. A customer clicks an ad and books (Waves 1–3)

1. The customer taps a Click-to-WhatsApp ad; the first message carries the ad's referral data.
2. The conversation is tagged with the ad (stored in slice 1; reports in Wave 1).
3. The agent or AI qualifies the lead, offers slots from the real calendar, and books.
4. Reports show ad → conversation → qualified → booked → completed, with the attribution window and unattributed
   results shown separately.

**Requirements:** CF-EXT-005, 003, 008, 017. **Acceptance:** 5 (no invented bookings).

## J4. A tenant reports a leak (Wave 3, maintenance package)

**People:** tenant, property manager, dispatcher, technician.
1. The tenant sends a photo and voice note: "Water leaking under the kitchen sink."
2. A structured service request is created (property, unit, category, urgency), with the photo scanned for malware.
3. The dispatcher triages; if a quote is needed, the tenant or landlord approves it in chat or in the customer
   control centre.
4. A technician is assigned by skill, area and availability; the customer gets an **arrival window**, and a
   **confirmed ETA** only when the technician confirms.
5. The technician completes a checklist with before/after photos; the customer confirms completion.
6. Invoice and payment link; feedback request; a warranty callback if the problem returns.

**What can go wrong:** no technician available (never invented; the customer is told and offered options); the
promised window is about to be missed (CF-EXT-018 warns staff; CF-EXT-023 suggests recovery).

**Requirements:** CF-EXT-017, 018, 020, 023, 015. **Acceptance:** 3, 5, 8.

## J5. An online shop recovers an abandoned cart (Wave 3)

1. Salla or Zid reports an abandoned cart (`abandoned.cart` / `abandoned_cart.created`).
2. If the customer has consented to marketing, a template message with the cart link is scheduled within frequency
   caps; otherwise nothing is sent.
3. The customer asks a question; an agent or AI answers using live stock from the store.
4. The customer pays through a hosted payment link; only the gateway's signed event marks the order paid.

**Requirements:** CF-EXT-014, 015, 004, 008. **Acceptance:** 1, 5, 6, 8.

## J6. An owner builds and rehearses an automation (Wave 2)

1. The owner picks the "appointment reminder" template in Arabic.
2. The draft is checked for loops and missing branches.
3. The owner rehearses it with simulated cases (duplicate events, mixed language, expired consent, no technician);
   nothing real is sent or changed.
4. The owner publishes; running workflows stay on the version they started with; rollback is one action.

**Requirements:** CF-EXT-007, 019, 024. **Acceptance:** 4, 10.

## J7. A customer checks status and reschedules (Wave 2)

1. The customer receives a secure, expiring link to their customer page.
2. They see request status, the appointment and quotes; they reschedule or ask for a person.
3. Revoking the link (or the customer's access) stops it working everywhere.

**Requirements:** CF-EXT-020, 026. **Acceptance:** 3, 9.

## J8. A supervisor takes over from the AI or an agent (Waves 1–2)

1. The supervisor sees a conversation going badly (repeat contact, complaint).
2. Taking over is explicit, recorded, and stops any AI replies (FR-206); the customer is not asked to repeat
   themselves because a summary is shown (CF-EXT-009).
3. The supervisor can **pause replies** with a reason and an expiry (or until released). Everyone else's replies — and
   any of their messages still waiting to be sent — are refused while the pause lasts; the reason is shown to the team.
   Internal notes keep working and never block replies.

**Requirements:** CF-EXT-002, 008, 009. **Acceptance:** 2, 5. **Status:** takeover (slice 1) and reply pause (slice 2) built and
tested locally; AI pause comes with the AI agent.
