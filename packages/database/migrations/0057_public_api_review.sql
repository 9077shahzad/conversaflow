-- 0057 Public API and webhooks: fixes from the independent review of W2.8.
--
-- * Webhook signing secrets are sealed (AES-256-GCM, key outside the database) instead of stored in plain text.
--   Nothing has been deployed with 0056, so any endpoint created locally is switched off and must be given a new
--   secret (rotate) before it is used again.
-- * Reclaiming an expired lease counts as an attempt, so a delivery that keeps crashing the worker gives up.
-- * The creator of an endpoint is remembered as a membership, so deliveries stop if that member loses access.
ALTER TABLE webhook_endpoints NO FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints ADD COLUMN secret_sealed text, ADD COLUMN previous_secret_sealed text,
  ADD COLUMN created_by_membership uuid REFERENCES memberships(id) ON DELETE SET NULL;
UPDATE webhook_endpoints e SET enabled = false, previous_until = NULL,
  created_by_membership = (SELECT m.id FROM memberships m WHERE m.tenant_id = e.tenant_id AND m.user_id = e.created_by LIMIT 1);
ALTER TABLE webhook_endpoints DROP COLUMN secret, DROP COLUMN previous_secret;
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_sealed CHECK (secret_sealed IS NULL OR secret_sealed LIKE 'v1.%');
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_enabled_has_secret CHECK (NOT enabled OR secret_sealed IS NOT NULL);
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
GRANT UPDATE (secret_sealed, previous_secret_sealed) ON webhook_endpoints TO cf_app;
GRANT INSERT (secret_sealed, created_by_membership) ON webhook_endpoints TO cf_app;

GRANT SELECT (attempts) ON webhook_deliveries TO cf_dispatch;
GRANT UPDATE (attempts) ON webhook_deliveries TO cf_dispatch;
CREATE OR REPLACE FUNCTION webhook_claim(p_limit integer, p_lease_seconds integer) RETURNS TABLE (delivery_id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE webhook_deliveries d SET state = 'leased', lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 600)), updated_at = now(),
    attempts = d.attempts + CASE WHEN d.state = 'leased' THEN 1 ELSE 0 END
  FROM (SELECT s.id FROM webhook_deliveries s
    WHERE (s.state = 'pending' AND s.next_attempt_at <= now()) OR (s.state = 'leased' AND s.lease_until < now())
    ORDER BY s.next_attempt_at LIMIT least(greatest(p_limit, 1), 100) FOR UPDATE SKIP LOCKED) pick
  WHERE d.id = pick.id
    AND ((d.state = 'pending' AND d.next_attempt_at <= now()) OR (d.state = 'leased' AND d.lease_until < now()))
  RETURNING d.id, d.tenant_id
$$;
