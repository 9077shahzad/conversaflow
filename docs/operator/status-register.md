# Conversa Operator: status register and work log

Addendum: `operator-addendum-v1.0-source.txt` (received 23 Oct 2026). Gap matrix at the start: `gap-matrix.md`.
This register is the persistent log the addendum asks for (§16): it says what exists, how it was verified and what is next,
so work can resume after any break.

**Overall status: Implemented locally (slice 1 of R1).** Nothing is in staging or production. WhatsApp is the sandbox,
there is no payment provider, no transcription service and no operations backend connected.

## Slices

| Slice | Requirements | Commits | Verification | Status |
| --- | --- | --- | --- | --- |
| 1. Price lists, cases, quotes, acceptance | FR-02, FR-05 (part), FR-06, FR-07, FR-08, FR-17 (part), FR-21 (part), FR-23 (settings and pause), AR-08 (quote states), UX-03/05/06 (quote page), SEC-05 (links); AC-04, AC-05, AC-06, AC-08 (part), AC-18 (part), AC-19 (part), AC-20 (part) | `5fd24ac` (0059), `24f1095` review fixes (0060), staff and customer screens (next commit) | Full runs 647/647 and 652/652 API, 16/16 browser; independent review (1 High, 6 Medium, 7 Low, all fixed) | Implemented locally |
| 2. Capacity, holds and booking | FR-09, FR-10, AC-07 | — | — | Next. Native resources and slots (owner action 12 (a)); exclusion constraint for the last slot |
| 3. Jobs and dispatch through a connector | FR-11, FR-15, AC-12, AC-14, AC-22 | — | — | Connector contract and native job backend; DOP/other live adapter blocked on owner action 12 (b) |
| 4. Completion evidence and customer sign-off | FR-12, AC-15, AC-16 | — | — | Planned |
| 5. Payments and reconciliation | FR-13, FR-14, AC-09–AC-11 | — | — | Provider-neutral part and labelled test provider planned; live adapter blocked on owner action 13 |
| 6. Exceptions queue, takeover packet, explicit handback, platform pause | FR-15, FR-16, FR-23, AC-13, AC-20, AC-27 | — | — | Planned |
| 7. Intake: structured extraction, voice notes, photos, evaluation set | FR-01, FR-03, AI-01–AI-10, AC-01–AC-03, AC-17 | — | — | Extraction and the 200-case synthetic set planned; transcription blocked on owner action 14; real recordings on owner action 15 |
| 8. Funnel reporting, follow-ups, docs set (§19) | FR-18, FR-19, FR-24, deliverables 1–16 | — | — | Planned |

## Decisions taken (routine, technical)

- Durable execution (AR-04): the existing PostgreSQL leased-job pattern (send jobs, inbound events, webhook deliveries, quote
  expiry) is kept instead of adding Temporal: it already survives restarts and deploys in tests, has no extra service to run
  or pay for, and the team operates one database. Revisit if long multi-step sagas outgrow it.
- Source of truth (§8): for a tenant on the native workflow, ConversaFlow owns price lists, quotes and acceptances. Jobs in
  an external system will be referenced by external id, never copied as a second master.
- Table names use the `op_` prefix: `workflow_*` already means messaging automations.
- Quote messages are fixed wording filled from the quote, never AI text, and go through the ordinary reply path.
- The customer page shows the honest outcome of a used link (accepted, expired, replaced) rather than refusing it.
- Recording an acceptance given another way (phone, in person) needs approval permission with two-step sign-in and a note.

## Known limits of slice 1 (recorded, not hidden)

- The quote link stays inside the stored copy of the message (as with customer links, W2.4 M3); it is single-use, expires
  with the quote, is masked in every staff, AI and API view, and is revoked when the quote closes.
- Automation mode is stored but does nothing yet; every quote is made and sent by a person.
- Service area keys are shown as codes in the staff screen; named areas come with the booking slice.
- No PDF of the quote yet (UX-02 asks for tested Arabic PDF output): planned with the documents slice.
