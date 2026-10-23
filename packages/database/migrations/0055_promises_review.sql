-- 0055 Promises: fixes from the independent review of W2.6.
--
-- * A closed promise (kept, put right, dismissed, cancelled) cannot be changed at all; an open or missed promise
--   always has an owner; closed promises record when they were closed.
-- * Suggestions whose deadline passes without being confirmed are closed by the worker (so the worker reads
--   suggestions too), with a note in the conversation, instead of lapsing silently.
-- * Notification de-duplication is per kind of alert, so a missed-promise alert is never swallowed by a waiting
--   new-message alert for the same conversation.
CREATE OR REPLACE FUNCTION promises_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.source IS DISTINCT FROM OLD.source OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a promise cannot be moved to another conversation' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('kept', 'recovered', 'dismissed', 'cancelled') THEN
    RAISE EXCEPTION 'a closed promise cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'suggested' AND NEW.status IN ('confirmed', 'dismissed'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('kept', 'missed', 'cancelled'))
    OR (OLD.status = 'missed' AND NEW.status IN ('kept', 'recovered'))) THEN
    RAISE EXCEPTION 'a promise cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'missed' AND (NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.description IS DISTINCT FROM OLD.description) THEN
    RAISE EXCEPTION 'a missed promise cannot be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE promises NO FORCE ROW LEVEL SECURITY;
UPDATE promises SET closed_at = coalesce(closed_at, now()) WHERE status IN ('kept', 'recovered', 'dismissed', 'cancelled') AND closed_at IS NULL;
ALTER TABLE promises FORCE ROW LEVEL SECURITY;
ALTER TABLE promises ADD CONSTRAINT promises_owner_when_open CHECK (status NOT IN ('confirmed', 'missed') OR owner_membership_id IS NOT NULL);
ALTER TABLE promises ADD CONSTRAINT promises_closed_when CHECK ((status IN ('kept', 'recovered', 'dismissed', 'cancelled')) = (closed_at IS NOT NULL));
ALTER TABLE promises ADD CONSTRAINT promises_missed_when CHECK (status NOT IN ('missed', 'recovered') OR missed_at IS NOT NULL);

DROP POLICY promises_dispatch_read ON promises;
CREATE POLICY promises_dispatch_read ON promises FOR SELECT TO cf_dispatch USING (status IN ('confirmed', 'suggested'));
CREATE OR REPLACE FUNCTION promises_due(p_limit integer) RETURNS TABLE (promise_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, p.tenant_id FROM promises p
  WHERE (p.status = 'confirmed' AND (p.due_at <= now() OR (p.warned_at IS NULL AND p.due_at <= now() + interval '1 hour')))
     OR (p.status = 'suggested' AND p.due_at <= now())
  ORDER BY p.due_at LIMIT least(greatest(p_limit, 1), 500)
$$;

DROP INDEX push_jobs_one_waiting;
CREATE UNIQUE INDEX push_jobs_one_waiting ON push_jobs (subscription_id, conversation_id, kind) WHERE state IN ('pending', 'leased') AND conversation_id IS NOT NULL;
