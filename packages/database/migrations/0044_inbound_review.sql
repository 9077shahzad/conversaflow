-- 0044 Incoming events: fixes from the independent review of AX-3 (migration 0042).
--
-- M1: STOP and START are applied in the order the customer sent them, not the order they are processed. With retries
-- and the manual "try again" action, an old START could otherwise be applied after a newer STOP. The time of the
-- customer's latest opt-out or opt-in keyword is kept with the contact; an older keyword is recorded but changes nothing.
ALTER TABLE contacts ADD COLUMN opt_keyword_at timestamptz;
GRANT UPDATE (opt_keyword_at) ON contacts TO cf_app;
ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY;
UPDATE contacts ct SET opt_keyword_at = m.at
FROM (SELECT e.contact_id, max(msg.occurred_at) AS at FROM consent_events e
      JOIN messages msg ON msg.provider_message_id = e.evidence AND msg.tenant_id = e.tenant_id
      WHERE e.source = 'inbound_keyword' GROUP BY e.contact_id) m
WHERE m.contact_id = ct.id;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

-- L1: one busy company cannot hold up the others. Each lease takes at most 50 waiting events per company, oldest
-- first, so a large backlog (for example a campaign's delivery updates) is shared out instead of queued ahead of
-- everyone else. Rows already being applied are skipped, never waited for.
CREATE OR REPLACE FUNCTION inbound_claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (event_id uuid, tenant_id uuid, connection_id uuid, account_ref uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE webhook_events w SET lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 600))
  WHERE w.id IN (
    SELECT s.id FROM webhook_events s
    WHERE s.id IN (
      SELECT q.id FROM (
        SELECT c.id, c.received_at, row_number() OVER (PARTITION BY c.tenant_id ORDER BY c.received_at, c.id) AS n
        FROM webhook_events c
        WHERE c.processed_at IS NULL AND c.failed_at IS NULL AND c.next_attempt_at <= now()
          AND (c.lease_until IS NULL OR c.lease_until < now())) q
      WHERE q.n <= 50
      ORDER BY q.received_at, q.id
      LIMIT least(greatest(p_limit, 1), 500))
    FOR UPDATE SKIP LOCKED)
  RETURNING w.id, w.tenant_id, w.connection_id, w.account_ref
$$;
