-- 0028 Response-time targets (SLA timers, BRD v1.2 Wave 1; FR-006 settings).
-- A timer starts when a customer writes and nobody owes them an answer yet: "first response" if no reply has ever
-- been sent in the conversation, otherwise "next response". It stops when a reply from the team is accepted by the
-- provider (sent), so a blocked or failed reply does not count as an answer. The due time is counted in business
-- hours (company time zone, holidays excluded) when business hours are set, otherwise in calendar time.
-- A missed target is recorded as an event when the late reply is sent; an open timer past its due time is shown as
-- overdue straight from these columns.

ALTER TABLE tenant_settings ADD COLUMN sla_next_response_minutes int CHECK (sla_next_response_minutes BETWEEN 1 AND 10080);

ALTER TABLE conversations ADD COLUMN sla_kind text CHECK (sla_kind IS NULL OR sla_kind IN ('first_response', 'next_response'));
ALTER TABLE conversations ADD COLUMN sla_started_at timestamptz;
ALTER TABLE conversations ADD COLUMN sla_due_at timestamptz;
-- When the team first answered this conversation (provider accepted the reply).
ALTER TABLE conversations ADD COLUMN first_response_at timestamptz;
ALTER TABLE conversations ADD CONSTRAINT conversations_sla_complete
  CHECK ((sla_kind IS NULL) = (sla_due_at IS NULL) AND (sla_kind IS NULL) = (sla_started_at IS NULL)
         AND (sla_due_at IS NULL OR sla_due_at >= sla_started_at));
CREATE INDEX conversations_sla_due ON conversations (tenant_id, sla_due_at) WHERE sla_due_at IS NOT NULL;
GRANT UPDATE (sla_kind, sla_started_at, sla_due_at, first_response_at) ON conversations TO cf_app;

ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check
  CHECK (kind IN ('assigned', 'unassigned', 'takeover', 'status_changed', 'opted_out', 'opted_in', 'paused', 'resumed', 'retried',
                  'sla_met', 'sla_missed'));
