-- 0018 Fixes from the independent review of candidate 3 (c6c51b8)
--  L-D  a dedicated owner role, cf_pilot, alone may write pilot enrolments and seat overrides, through exactly two
--       token-bound console functions; the operations role loses those rights (the CI guard checks by owner).
--  L-C  pilot invitations: pending ones are cut to 72 hours at enrolment, and the database itself caps any pilot
--       invitation at 72 hours (application code no longer the only guard).
--  L-A  identity references: digit runs with separators, Arabic-Indic, Persian and full-width digits are refused.
--  L-B  platform owners can list open reset requests (reason, method, reference) before approving.
--  Informational: at most 5 confirmation-code emails per user per hour.

-- L-D --------------------------------------------------------------------------------------------------------
GRANT USAGE, CREATE ON SCHEMA public TO cf_pilot;  -- needed to own functions, as for cf_auth and cf_ops
DROP POLICY pilot_ops_read ON pilot_enrolments;
DROP POLICY pilot_ops_insert ON pilot_enrolments;
DROP POLICY pilot_ops_end ON pilot_enrolments;
REVOKE ALL ON pilot_enrolments FROM cf_ops;
DROP POLICY overrides_ops_read ON entitlement_overrides;
DROP POLICY overrides_ops_insert ON entitlement_overrides;
DROP POLICY overrides_ops_expire ON entitlement_overrides;
REVOKE ALL ON entitlement_overrides FROM cf_ops;

CREATE POLICY pilot_owner_read   ON pilot_enrolments FOR SELECT TO cf_pilot USING (true);
CREATE POLICY pilot_owner_insert ON pilot_enrolments FOR INSERT TO cf_pilot WITH CHECK (true);
CREATE POLICY pilot_owner_end    ON pilot_enrolments FOR UPDATE TO cf_pilot USING (ended_at IS NULL) WITH CHECK (ended_at IS NOT NULL);
GRANT SELECT (id, tenant_id, ended_at, seat_override_id, requires_mfa, starts_at, ends_at) ON pilot_enrolments TO cf_pilot;
GRANT INSERT (tenant_id, seat_allowance, reason, ends_at, seat_override_id, enrolled_by) ON pilot_enrolments TO cf_pilot;
GRANT UPDATE (ended_at) ON pilot_enrolments TO cf_pilot;

CREATE POLICY overrides_pilot_read   ON entitlement_overrides FOR SELECT TO cf_pilot USING (key = 'seats');
CREATE POLICY overrides_pilot_insert ON entitlement_overrides FOR INSERT TO cf_pilot
  WITH CHECK (key = 'seats' AND expires_at IS NOT NULL AND expires_at <= now() + interval '181 days');
CREATE POLICY overrides_pilot_expire ON entitlement_overrides FOR UPDATE TO cf_pilot
  USING (key = 'seats') WITH CHECK (key = 'seats' AND expires_at IS NOT NULL AND expires_at <= now());
GRANT SELECT (id, expires_at, key) ON entitlement_overrides TO cf_pilot;
GRANT INSERT (tenant_id, key, limit_value, reason, granted_by, expires_at) ON entitlement_overrides TO cf_pilot;
GRANT UPDATE (expires_at) ON entitlement_overrides TO cf_pilot;

-- What the two functions need besides those tables.
GRANT SELECT (id) ON tenants TO cf_pilot;
CREATE POLICY pilot_owner_tenants ON tenants FOR SELECT TO cf_pilot USING (true);
GRANT INSERT ON platform_audit_events TO cf_pilot;
CREATE POLICY pilot_owner_audit ON platform_audit_events FOR INSERT TO cf_pilot WITH CHECK (true);
GRANT EXECUTE ON FUNCTION platform_require(text, text) TO cf_pilot;
GRANT SELECT (id, tenant_id, accepted_at, revoked_at, expires_at) ON invitations TO cf_pilot;
GRANT UPDATE (expires_at) ON invitations TO cf_pilot;
CREATE POLICY pilot_owner_invitations_read ON invitations FOR SELECT TO cf_pilot USING (true);
CREATE POLICY pilot_owner_invitations_cut  ON invitations FOR UPDATE TO cf_pilot
  USING (accepted_at IS NULL AND revoked_at IS NULL) WITH CHECK (expires_at <= now() + interval '72 hours');

ALTER FUNCTION platform_enrol_pilot(text, uuid, int, int, text) OWNER TO cf_pilot;
ALTER FUNCTION platform_end_pilot(text, uuid) OWNER TO cf_pilot;

-- L-C: enrolment also cuts the company's pending invitations to 72 hours.
CREATE OR REPLACE FUNCTION platform_enrol_pilot(p_token text, p_tenant uuid, p_seats int, p_days int, p_reason text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_ends timestamptz; v_override uuid; v_cut int;
BEGIN
  IF p_days IS NULL OR p_days NOT BETWEEN 7 AND 180 THEN
    RAISE EXCEPTION 'pilot length must be 7 to 180 days' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) THEN
    RAISE EXCEPTION 'company not found' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM pilot_enrolments WHERE tenant_id = p_tenant AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'this company already has a running pilot' USING ERRCODE = 'check_violation';
  END IF;
  v_ends := now() + make_interval(days => p_days);
  INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason, granted_by, expires_at)
  VALUES (p_tenant, 'seats', p_seats, 'Pilot seat allowance: ' || p_reason, v_staff, v_ends)
  RETURNING id INTO v_override;
  INSERT INTO pilot_enrolments (tenant_id, seat_allowance, reason, ends_at, seat_override_id, enrolled_by)
  VALUES (p_tenant, p_seats, p_reason, v_ends, v_override, v_staff);
  UPDATE invitations SET expires_at = now() + interval '72 hours'
  WHERE tenant_id = p_tenant AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() + interval '72 hours';
  GET DIAGNOSTICS v_cut = ROW_COUNT;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'pilot.enrolled', 'tenant', p_tenant::text,
          jsonb_build_object('seats', p_seats, 'days', p_days, 'requiresMfa', true, 'endsAt', v_ends, 'invitationsCutTo72h', v_cut));
  RETURN v_ends;
END $$;

-- L-C: the database caps every invitation of a company with a running pilot at 72 hours, on insert and on update.
CREATE FUNCTION invitations_pilot_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pilot_enrolments p
             WHERE p.tenant_id = NEW.tenant_id AND p.ended_at IS NULL AND p.starts_at <= now() AND p.ends_at > now()) THEN
    NEW.expires_at := least(NEW.expires_at, now() + interval '72 hours');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitations_pilot_cap BEFORE INSERT OR UPDATE OF expires_at ON invitations
  FOR EACH ROW EXECUTE FUNCTION invitations_pilot_cap();

-- L-A --------------------------------------------------------------------------------------------------------
ALTER TABLE mfa_reset_requests DROP CONSTRAINT mfa_reset_requests_identity_reference_check;
ALTER TABLE mfa_reset_requests ADD CONSTRAINT mfa_reset_requests_identity_reference_check CHECK (
  length(trim(identity_reference)) BETWEEN 10 AND 200
  -- six or more digits (ASCII, Arabic-Indic, Persian or full-width) in a run, even with spaces, dashes, dots or slashes
  AND identity_reference !~ '([0-9٠-٩۰-۹０-９][[:space:]./-]?){6,}'
);

-- L-B --------------------------------------------------------------------------------------------------------
CREATE FUNCTION platform_list_mfa_resets(p_token text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_rows jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'user', u.email, 'reason', r.reason, 'identityMethod', r.identity_method,
           'identityReference', r.identity_reference, 'requestedBy', q.email, 'requestedByYou', r.requested_by = v_staff,
           'createdAt', r.created_at, 'expiresAt', r.expires_at) ORDER BY r.created_at), '[]'::jsonb)
    INTO v_rows
  FROM mfa_reset_requests r JOIN users u ON u.id = r.user_id JOIN users q ON q.id = r.requested_by
  WHERE r.approved_at IS NULL AND r.rejected_at IS NULL AND r.expires_at > now();
  RETURN v_rows;
END $$;
ALTER FUNCTION platform_list_mfa_resets(text) OWNER TO cf_ops;
REVOKE ALL ON FUNCTION platform_list_mfa_resets(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_mfa_resets(text) TO cf_platform;

-- Informational: cap confirmation-code emails at 5 per user per hour (a successful first-code step is counted).
CREATE OR REPLACE FUNCTION auth_mfa_confirm_code(p_token_hash bytea, p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_session uuid; v_user uuid; v_factor uuid; v_ok boolean; v_email citext; v_verified timestamptz;
BEGIN
  SELECT session_id, user_id INTO v_session, v_user FROM auth_session_from_token(p_token_hash);
  IF v_user IS NULL THEN RAISE EXCEPTION 'no active session' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT email, email_verified_at INTO v_email, v_verified FROM users WHERE id = v_user;
  IF v_verified IS NULL THEN RAISE EXCEPTION 'email address not verified' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM auth_mfa_guard(v_user);
  IF (SELECT count(*) FROM mfa_attempts WHERE user_id = v_user AND ok AND at > now() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION 'too many confirmation emails; try again later' USING ERRCODE = 'program_limit_exceeded';
  END IF;
  SELECT id INTO v_factor FROM mfa_factors WHERE user_id = v_user AND type = 'totp' AND confirmed_at IS NULL;
  v_ok := v_factor IS NOT NULL AND auth_totp_check(v_factor, p_code);
  INSERT INTO mfa_attempts (user_id, ok) VALUES (v_user, v_ok);
  IF NOT v_ok THEN RETURN false; END IF;
  UPDATE mfa_factors SET code_verified_at = now(), enrol_session_id = v_session WHERE id = v_factor;
  UPDATE mfa_activation_codes SET used_at = now() WHERE factor_id = v_factor AND used_at IS NULL;
  INSERT INTO auth_email_requests (purpose, email, factor_id) VALUES ('mfa_activate', v_email, v_factor);
  RETURN true;
END $$;
