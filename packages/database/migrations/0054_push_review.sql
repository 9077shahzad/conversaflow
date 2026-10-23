-- 0054 Notifications: fixes from the independent review of W2.5.
--
-- One waiting alert per device and conversation is enforced by the database (two messages at once cannot both queue
-- one). A lease that ran out counts as an attempt, so an alert is never resent without limit after a crash.
CREATE UNIQUE INDEX push_jobs_one_waiting ON push_jobs (subscription_id, conversation_id) WHERE state IN ('pending', 'leased') AND conversation_id IS NOT NULL;
GRANT SELECT (attempts), UPDATE (attempts) ON push_jobs TO cf_dispatch;

CREATE OR REPLACE FUNCTION push_claim(p_limit integer, p_lease_seconds integer) RETURNS TABLE (job_id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE push_jobs j SET state = 'leased', lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 600)), updated_at = now(),
                         attempts = j.attempts + CASE WHEN j.state = 'leased' THEN 1 ELSE 0 END
  WHERE j.id IN (
    SELECT s.id FROM push_jobs s
    WHERE (s.state = 'pending' AND s.next_attempt_at <= now()) OR (s.state = 'leased' AND s.lease_until < now())
    ORDER BY s.next_attempt_at
    LIMIT least(greatest(p_limit, 1), 200)
    FOR UPDATE SKIP LOCKED)
    AND ((j.state = 'pending' AND j.next_attempt_at <= now()) OR (j.state = 'leased' AND j.lease_until < now()))
  RETURNING j.id, j.tenant_id
$$;
