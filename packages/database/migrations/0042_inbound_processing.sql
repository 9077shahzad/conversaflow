-- 0042 Incoming webhook events are applied by the worker (AX-3, backlog W1.3).
--
-- The webhook request now only checks the signature, routes each event to its company and records it. It answers
-- WhatsApp straight away. The worker applies recorded events (contacts, conversations, messages, statuses, template
-- changes), retrying with back-off, and stops after a fixed number of attempts so a person can look ("failed").
-- Applying and marking an event as processed happen in one transaction, so an event is applied at most once, and
-- a crash between recording and applying loses nothing: the event waits until a worker picks it up.

-- The parsed event, as the request understood it (the raw part stays in `payload`).
ALTER TABLE webhook_events ADD COLUMN parsed jsonb CHECK (parsed IS NULL OR jsonb_typeof(parsed) = 'object');
ALTER TABLE webhook_events ADD COLUMN attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100);
ALTER TABLE webhook_events ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE webhook_events ADD COLUMN lease_until timestamptz;
-- A short error code only (never message content).
ALTER TABLE webhook_events ADD COLUMN last_error text CHECK (last_error IS NULL OR length(last_error) <= 120);
-- Set when the worker gave up; cleared when a person asks to try again.
ALTER TABLE webhook_events ADD COLUMN failed_at timestamptz;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_done_or_failed CHECK (processed_at IS NULL OR failed_at IS NULL);

CREATE INDEX webhook_events_due ON webhook_events (next_attempt_at) WHERE processed_at IS NULL AND failed_at IS NULL;
CREATE INDEX webhook_events_failed ON webhook_events (tenant_id) WHERE failed_at IS NOT NULL;

GRANT UPDATE (attempts, next_attempt_at, lease_until, last_error, failed_at) ON webhook_events TO cf_app;

-- The worker finds waiting events across companies through one lookup owned by the leasing role, which sees only
-- scheduling columns (no payload, no parsed content). Each company's events are then applied as cf_app in that
-- company's context.
GRANT SELECT (id, tenant_id, connection_id, account_ref, received_at, processed_at, failed_at, next_attempt_at, lease_until)
  ON webhook_events TO cf_dispatch;
GRANT UPDATE (lease_until) ON webhook_events TO cf_dispatch;
CREATE POLICY webhook_events_dispatch_read ON webhook_events FOR SELECT TO cf_dispatch
  USING (processed_at IS NULL AND failed_at IS NULL);
CREATE POLICY webhook_events_dispatch_lease ON webhook_events FOR UPDATE TO cf_dispatch
  USING (processed_at IS NULL AND failed_at IS NULL) WITH CHECK (processed_at IS NULL AND failed_at IS NULL);

CREATE FUNCTION inbound_claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (event_id uuid, tenant_id uuid, connection_id uuid, account_ref uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE webhook_events w SET lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 600))
  WHERE w.id IN (
    SELECT s.id FROM webhook_events s
    WHERE s.processed_at IS NULL AND s.failed_at IS NULL AND s.next_attempt_at <= now()
      AND (s.lease_until IS NULL OR s.lease_until < now())
    ORDER BY s.received_at
    LIMIT least(greatest(p_limit, 1), 500)
    FOR UPDATE SKIP LOCKED)
  RETURNING w.id, w.tenant_id, w.connection_id, w.account_ref
$$;
ALTER FUNCTION inbound_claim(integer, integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION inbound_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inbound_claim(integer, integer) TO cf_app;
