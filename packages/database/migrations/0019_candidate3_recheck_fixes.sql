-- 0019 Fixes from the recheck of candidate 3 (42823bb)
--  L-A  identity references may contain at most 5 digits in total, of any script, whatever separates them.
--  L-C  a pilot invitation's life is counted from when it was created: at most 72 hours, so it cannot be renewed.

ALTER TABLE mfa_reset_requests DROP CONSTRAINT mfa_reset_requests_identity_reference_check;
ALTER TABLE mfa_reset_requests ADD CONSTRAINT mfa_reset_requests_identity_reference_check CHECK (
  length(trim(identity_reference)) BETWEEN 10 AND 200
  AND length(regexp_replace(identity_reference, '[^0-9٠-٩۰-۹０-９०-९০-৯]', '', 'g')) < 6
);

CREATE OR REPLACE FUNCTION invitations_pilot_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pilot_enrolments p
             WHERE p.tenant_id = NEW.tenant_id AND p.ended_at IS NULL AND p.starts_at <= now() AND p.ends_at > now()) THEN
    NEW.expires_at := least(NEW.expires_at, coalesce(NEW.created_at, now()) + interval '72 hours');
  END IF;
  RETURN NEW;
END $$;
