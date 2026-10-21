-- 0035 Campaign counts: fix from the final recheck of slice 4 (finding P2-1).
--
-- A campaign message that WhatsApp temporarily declines ("not accepted", e.g. a rate limit) goes back to the queue and
-- is tried again. It is counted once, at its first hand-over, and keeps its place while it is retried (the sender
-- skips the check for a message that is already counted). If it then ends as "blocked" (a later check stopped it,
-- such as a cancelled campaign or an opt-out), it never reached anyone and no longer counts, exactly like a message
-- WhatsApp refused ("rejected") or declined on every attempt ("exhausted").
--
-- Only the three definitions change (same signatures, so their grants are kept).
CREATE OR REPLACE FUNCTION campaign_contact_blocked(p_contact uuid, p_per_7d integer, p_gap_hours integer, p_waiting boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH counted AS (
    SELECT k.counted_at FROM campaign_send_counts k JOIN messages m ON m.id = k.message_id
    WHERE k.contact_id = p_contact AND k.counted_at > now() - interval '7 days'
      AND NOT (m.status = 'failed' AND m.failure_kind IN ('rejected', 'exhausted', 'blocked'))
    UNION ALL
    SELECT now() FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE p_waiting AND c.contact_id = p_contact AND m.campaign_id IS NOT NULL AND m.status = 'queued'
      AND NOT EXISTS (SELECT 1 FROM campaign_send_counts k2 WHERE k2.message_id = m.id))
  SELECT count(*) >= p_per_7d OR coalesce(max(counted_at) > now() - make_interval(hours => p_gap_hours), false) FROM counted
$$;

CREATE OR REPLACE FUNCTION campaign_daily_used(p_connection uuid, p_waiting boolean) RETURNS integer
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT ((SELECT count(*) FROM campaign_send_counts k JOIN messages m ON m.id = k.message_id
           WHERE k.connection_id = p_connection AND k.counted_at > now() - interval '24 hours'
             AND NOT (m.status = 'failed' AND m.failure_kind IN ('rejected', 'exhausted', 'blocked')))
        + (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE p_waiting AND c.connection_id = p_connection AND m.campaign_id IS NOT NULL AND m.status = 'queued'
             AND NOT EXISTS (SELECT 1 FROM campaign_send_counts k2 WHERE k2.message_id = m.id)))::integer
$$;

CREATE OR REPLACE FUNCTION campaign_daily_room_at(p_connection uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT greatest(min(k.counted_at) + interval '24 hours', now() + interval '60 seconds')
  FROM campaign_send_counts k JOIN messages m ON m.id = k.message_id
  WHERE k.connection_id = p_connection AND k.counted_at > now() - interval '24 hours'
    AND NOT (m.status = 'failed' AND m.failure_kind IN ('rejected', 'exhausted', 'blocked'))
$$;
