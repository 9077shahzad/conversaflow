-- 0046 Fixes from the recheck of AX-3 and W1.9 (findings N1 and N3).
--
-- N1: the data backfills in 0043 (ad attribution of existing conversations) and 0044 (time of each contact's latest
-- STOP/START) read tables that keep forced row security, so as the migration owner they saw no rows and changed
-- nothing. They are run again here with row security relaxed on every table they read and write, and only fill what
-- is still missing.
ALTER TABLE messages NO FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_attributions NO FORCE ROW LEVEL SECURITY;

INSERT INTO conversation_attributions (conversation_id, tenant_id, contact_id, message_id, source_type, source_id, source_url, headline, ctwa_clid, new_contact, first_message_at)
SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.tenant_id, c.contact_id, m.id,
       CASE WHEN m.referral->>'source_type' IN ('ad', 'post') THEN m.referral->>'source_type' ELSE 'unknown' END,
       left(m.referral->>'source_id', 100), left(m.referral->>'source_url', 500), left(m.referral->>'headline', 300), left(m.referral->>'ctwa_clid', 300),
       NOT EXISTS (SELECT 1 FROM conversations p WHERE p.contact_id = c.contact_id AND p.created_at < c.created_at)
         AND NOT EXISTS (SELECT 1 FROM messages e WHERE e.conversation_id = m.conversation_id AND e.occurred_at < m.occurred_at),
       m.occurred_at
FROM messages m JOIN conversations c ON c.id = m.conversation_id
WHERE m.direction = 'in' AND m.referral IS NOT NULL
ORDER BY m.conversation_id, m.occurred_at, m.id
ON CONFLICT (conversation_id) DO NOTHING;

UPDATE contacts ct SET opt_keyword_at = k.at
FROM (SELECT e.contact_id, max(msg.occurred_at) AS at FROM consent_events e
      JOIN messages msg ON msg.provider_message_id = e.evidence AND msg.tenant_id = e.tenant_id
      WHERE e.source = 'inbound_keyword' GROUP BY e.contact_id) k
WHERE k.contact_id = ct.id AND ct.opt_keyword_at IS NULL;

ALTER TABLE conversation_attributions FORCE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_events FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;

-- N3: the rows actually leased are checked again for being waiting and unleased, so two workers claiming at the same
-- moment never lease the same event twice.
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
      AND s.processed_at IS NULL AND s.failed_at IS NULL AND s.next_attempt_at <= now()
      AND (s.lease_until IS NULL OR s.lease_until < now())
    FOR UPDATE SKIP LOCKED)
  RETURNING w.id, w.tenant_id, w.connection_id, w.account_ref
$$;

-- Recheck W3: when the customer first wrote in each conversation, kept on the conversation so reports do not scan
-- every message (set when an incoming message is applied; filled here for existing conversations).
ALTER TABLE conversations ADD COLUMN first_inbound_at timestamptz;
GRANT UPDATE (first_inbound_at) ON conversations TO cf_app;
CREATE INDEX conversations_first_inbound ON conversations (tenant_id, first_inbound_at) WHERE first_inbound_at IS NOT NULL;
ALTER TABLE conversations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE messages NO FORCE ROW LEVEL SECURITY;
UPDATE conversations c SET first_inbound_at = f.at
FROM (SELECT conversation_id, min(occurred_at) AS at FROM messages WHERE direction = 'in' GROUP BY conversation_id) f
WHERE f.conversation_id = c.id;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
