-- 0036 Campaign counts per hand-over (final recheck of slice 4, finding B-1).
--
-- Before: one count per message, taken at its first hand-over; a message declined by WhatsApp kept that count and was
-- not checked again when retried (0035). A retry long after the first hand-over (for example after a pause) was then
-- sent without any limit check, and its old count no longer fell inside the windows.
--
-- Now: one count per hand-over (per attempt). An attempt that WhatsApp definitely declined ("not accepted") or refused
-- ("rejected") stops counting as soon as its outcome is recorded, because nothing reached anyone. Every retry is checked
-- again in full, at its own time, and counted from then. What counts:
--   * campaign messages only, from each hand-over to WhatsApp, timed from that hand-over;
--   * a hand-over counts unless its attempt was definitely declined or refused, or the message ended as "rejected",
--     "exhausted" or "blocked" (never reached anyone);
--   * an attempt still in flight, uncertain, interrupted or accepted (also late) counts;
--   * when queueing, messages already queued count too, as if sent now (their earlier hand-overs were all declined, so
--     nothing is counted twice).
ALTER TABLE campaign_send_counts ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20);
ALTER TABLE campaign_send_counts ALTER COLUMN attempt DROP DEFAULT;   -- existing rows were all first hand-overs
ALTER TABLE campaign_send_counts DROP CONSTRAINT campaign_send_counts_pkey;
ALTER TABLE campaign_send_counts ADD PRIMARY KEY (tenant_id, message_id, attempt);

CREATE OR REPLACE FUNCTION campaign_contact_blocked(p_contact uuid, p_per_7d integer, p_gap_hours integer, p_waiting boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH counted AS (
    SELECT k.counted_at FROM campaign_send_counts k JOIN messages m ON m.id = k.message_id
    WHERE k.contact_id = p_contact AND k.counted_at > now() - interval '7 days'
      AND NOT (m.status = 'failed' AND m.failure_kind IN ('rejected', 'exhausted', 'blocked'))
      AND NOT EXISTS (SELECT 1 FROM send_attempts a WHERE a.message_id = k.message_id AND a.attempt = k.attempt
                        AND a.outcome IN ('not_accepted', 'rejected'))
    UNION ALL
    SELECT now() FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE p_waiting AND c.contact_id = p_contact AND m.campaign_id IS NOT NULL AND m.status = 'queued')
  SELECT count(*) >= p_per_7d OR coalesce(max(counted_at) > now() - make_interval(hours => p_gap_hours), false) FROM counted
$$;

CREATE OR REPLACE FUNCTION campaign_daily_used(p_connection uuid, p_waiting boolean) RETURNS integer
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT ((SELECT count(*) FROM campaign_send_counts k JOIN messages m ON m.id = k.message_id
           WHERE k.connection_id = p_connection AND k.counted_at > now() - interval '24 hours'
             AND NOT (m.status = 'failed' AND m.failure_kind IN ('rejected', 'exhausted', 'blocked'))
             AND NOT EXISTS (SELECT 1 FROM send_attempts a WHERE a.message_id = k.message_id AND a.attempt = k.attempt
                               AND a.outcome IN ('not_accepted', 'rejected')))
        + (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE p_waiting AND c.connection_id = p_connection AND m.campaign_id IS NOT NULL AND m.status = 'queued'))::integer
$$;

CREATE OR REPLACE FUNCTION campaign_daily_room_at(p_connection uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT greatest(min(k.counted_at) + interval '24 hours', now() + interval '60 seconds')
  FROM campaign_send_counts k JOIN messages m ON m.id = k.message_id
  WHERE k.connection_id = p_connection AND k.counted_at > now() - interval '24 hours'
    AND NOT (m.status = 'failed' AND m.failure_kind IN ('rejected', 'exhausted', 'blocked'))
    AND NOT EXISTS (SELECT 1 FROM send_attempts a WHERE a.message_id = k.message_id AND a.attempt = k.attempt
                      AND a.outcome IN ('not_accepted', 'rejected'))
$$;
