-- 0020 Final recheck of candidate 3 (4e60aeb), L-C: the business role can no longer set an invitation's creation time,
-- and the 72-hour pilot cap uses the original creation time on update and never a future one on insert.
REVOKE INSERT, UPDATE ON invitations FROM cf_app;
GRANT INSERT (tenant_id, email, role_id, token_hash, invited_by, expires_at) ON invitations TO cf_app;
GRANT UPDATE (accepted_at, revoked_at, expires_at) ON invitations TO cf_app;

CREATE OR REPLACE FUNCTION invitations_pilot_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_created timestamptz;
BEGIN
  v_created := CASE WHEN TG_OP = 'UPDATE' THEN OLD.created_at ELSE least(coalesce(NEW.created_at, now()), now()) END;
  IF EXISTS (SELECT 1 FROM pilot_enrolments p
             WHERE p.tenant_id = NEW.tenant_id AND p.ended_at IS NULL AND p.starts_at <= now() AND p.ends_at > now()) THEN
    NEW.expires_at := least(NEW.expires_at, v_created + interval '72 hours');
  END IF;
  RETURN NEW;
END $$;
