-- 0034 Campaign limits checked at send time (owner instructions of 21 Oct 2026, 11:01).
--
-- What counts toward the campaign limits (per contact: at most N in 7 days and a minimum gap; per number: at most the
-- daily limit in a rolling 24 hours):
--   * campaign messages only (ordinary replies and individually sent templates do not count);
--   * counted at the moment the sender hands the message to WhatsApp (moves it to "submitting"), timed from then;
--   * they keep counting whatever happens next (sent, delivered, read, uncertain, reported undelivered), except when
--     WhatsApp definitely refused the message (failure kind "rejected" or "exhausted"): those never reached anyone.
-- Messages still waiting to be sent are not counted here; the sender counts each one when it goes.
--
-- The sender writes one row per campaign message, in the same transaction that moves it to "submitting", after
-- checking the limits under a per-company lock. Two senders therefore cannot both use the last place under a limit.
CREATE TABLE campaign_send_counts (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id     uuid NOT NULL,
  campaign_id    uuid NOT NULL,
  connection_id  uuid NOT NULL,
  contact_id     uuid NOT NULL,
  counted_at     timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (counted_at <= clock_timestamp() + interval '1 minute'),
  PRIMARY KEY (tenant_id, message_id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, connection_id) REFERENCES channel_connections (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX campaign_send_counts_contact ON campaign_send_counts (tenant_id, contact_id, counted_at);
CREATE INDEX campaign_send_counts_connection ON campaign_send_counts (tenant_id, connection_id, counted_at);

ALTER TABLE campaign_send_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_send_counts FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_send_counts_tenant ON campaign_send_counts FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON campaign_send_counts TO cf_app;   -- append-only

-- Campaign messages already handed to WhatsApp before this migration are counted from their first attempt.
ALTER TABLE campaign_send_counts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE messages NO FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE send_attempts NO FORCE ROW LEVEL SECURITY;
INSERT INTO campaign_send_counts (tenant_id, message_id, campaign_id, connection_id, contact_id, counted_at)
  SELECT m.tenant_id, m.id, m.campaign_id, c.connection_id, c.contact_id,
         least(coalesce((SELECT min(a.created_at) FROM send_attempts a WHERE a.message_id = m.id), m.created_at), clock_timestamp())
  FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE m.campaign_id IS NOT NULL AND m.status NOT IN ('queued')
    AND NOT (m.status = 'failed' AND m.failure_kind = 'blocked')
  ON CONFLICT DO NOTHING;
ALTER TABLE campaign_send_counts FORCE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE send_attempts FORCE ROW LEVEL SECURITY;

-- One definition of "what counts", used when queueing (p_waiting = true: queued campaign messages count as if sent now)
-- and at send time (p_waiting = false). Ordinary functions (SECURITY INVOKER): they run as the caller, under the
-- caller's row security, so they only ever see the caller's company.
CREATE FUNCTION campaign_contact_blocked(p_contact uuid, p_per_7d integer, p_gap_hours integer, p_waiting boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH counted AS (
    SELECT k.counted_at FROM campaign_send_counts k JOIN messages m ON m.id = k.message_id
    WHERE k.contact_id = p_contact AND k.counted_at > now() - interval '7 days'
      AND NOT (m.status = 'failed' AND m.failure_kind IN ('rejected', 'exhausted'))
    UNION ALL
    SELECT now() FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE p_waiting AND c.contact_id = p_contact AND m.campaign_id IS NOT NULL AND m.status = 'queued')
  SELECT count(*) >= p_per_7d OR coalesce(max(counted_at) > now() - make_interval(hours => p_gap_hours), false) FROM counted
$$;

CREATE FUNCTION campaign_daily_used(p_connection uuid, p_waiting boolean) RETURNS integer
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT ((SELECT count(*) FROM campaign_send_counts k JOIN messages m ON m.id = k.message_id
           WHERE k.connection_id = p_connection AND k.counted_at > now() - interval '24 hours'
             AND NOT (m.status = 'failed' AND m.failure_kind IN ('rejected', 'exhausted')))
        + (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE p_waiting AND c.connection_id = p_connection AND m.campaign_id IS NOT NULL AND m.status = 'queued'))::integer
$$;

-- When room next frees up on a number: the oldest counted message in the window turns 24 hours old.
CREATE FUNCTION campaign_daily_room_at(p_connection uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT greatest(min(k.counted_at) + interval '24 hours', now() + interval '60 seconds')
  FROM campaign_send_counts k JOIN messages m ON m.id = k.message_id
  WHERE k.connection_id = p_connection AND k.counted_at > now() - interval '24 hours'
    AND NOT (m.status = 'failed' AND m.failure_kind IN ('rejected', 'exhausted'))
$$;
REVOKE ALL ON FUNCTION campaign_contact_blocked(uuid, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION campaign_daily_used(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION campaign_daily_room_at(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campaign_contact_blocked(uuid, integer, integer, boolean) TO cf_app;
GRANT EXECUTE ON FUNCTION campaign_daily_used(uuid, boolean) TO cf_app;
GRANT EXECUTE ON FUNCTION campaign_daily_room_at(uuid) TO cf_app;
