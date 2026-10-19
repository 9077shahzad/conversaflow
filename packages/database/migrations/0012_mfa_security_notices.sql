-- 0012 Security notices for two-step sign-in (mitigation M5, docs/readiness/pilot-mfa-residual-risk.md)
-- The account owner is emailed when two-step sign-in is turned on and when a recovery code is used. The notices are
-- queued by the authentication functions themselves (owned by cf_auth), so no login role can skip them, and the
-- generic email request function can no longer queue these purposes (so it cannot be used to forge them either).

ALTER TABLE auth_email_requests DROP CONSTRAINT auth_email_requests_purpose_check;
ALTER TABLE auth_email_requests ADD CONSTRAINT auth_email_requests_purpose_check
  CHECK (purpose IN ('verify_email', 'reset_password', 'signup_existing', 'mfa_enabled', 'recovery_code_used'));

CREATE OR REPLACE FUNCTION auth_request_email(p_purpose text, p_email citext) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_purpose NOT IN ('verify_email', 'reset_password', 'signup_existing') THEN
    RAISE EXCEPTION 'security notices are raised by the authentication functions only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO auth_email_requests (purpose, email) VALUES (p_purpose, p_email);
END $$;

CREATE OR REPLACE FUNCTION auth_mfa_confirm(p_token_hash bytea, p_code text, p_recovery_hashes bytea[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_session uuid; v_user uuid; v_factor uuid; v_ok boolean;
BEGIN
  SELECT session_id, user_id INTO v_session, v_user FROM auth_session_from_token(p_token_hash);
  IF v_user IS NULL THEN RAISE EXCEPTION 'no active session' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF cardinality(p_recovery_hashes) <> 10 OR EXISTS (SELECT 1 FROM unnest(p_recovery_hashes) h WHERE length(h) <> 32) THEN
    RAISE EXCEPTION 'ten SHA-256 recovery code hashes are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM auth_mfa_guard(v_user);
  SELECT id INTO v_factor FROM mfa_factors WHERE user_id = v_user AND type = 'totp' AND confirmed_at IS NULL;
  v_ok := v_factor IS NOT NULL AND auth_totp_check(v_factor, p_code);
  INSERT INTO mfa_attempts (user_id, ok) VALUES (v_user, v_ok);
  IF NOT v_ok THEN RETURN false; END IF;
  UPDATE mfa_factors SET confirmed_at = now() WHERE id = v_factor;
  DELETE FROM mfa_recovery_codes WHERE user_id = v_user;
  INSERT INTO mfa_recovery_codes (user_id, code_hash) SELECT v_user, h FROM unnest(p_recovery_hashes) h;
  UPDATE sessions SET mfa_verified_at = now() WHERE id = v_session;
  UPDATE sessions SET revoked_at = now(), revoke_reason = 'mfa_enabled'
  WHERE user_id = v_user AND revoked_at IS NULL AND id <> v_session;
  -- Security notice to the account's stored address (mitigation M5). Raised here, inside the function, so a holder
  -- of the sign-in credential cannot enable two-step sign-in for someone without them being told.
  INSERT INTO auth_email_requests (purpose, email) SELECT 'mfa_enabled', u.email FROM users u WHERE u.id = v_user;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION auth_mfa_verify(p_token_hash bytea, p_code text, p_recovery_hash bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_session uuid; v_user uuid; v_factor uuid; v_ok boolean := false;
BEGIN
  SELECT session_id, user_id INTO v_session, v_user FROM auth_session_from_token(p_token_hash);
  IF v_user IS NULL THEN RAISE EXCEPTION 'no active session' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM auth_mfa_guard(v_user);
  IF p_recovery_hash IS NOT NULL THEN
    UPDATE mfa_recovery_codes SET used_at = now()
    WHERE id = (SELECT id FROM mfa_recovery_codes WHERE user_id = v_user AND code_hash = p_recovery_hash AND used_at IS NULL
                LIMIT 1 FOR UPDATE)
      AND used_at IS NULL;
    v_ok := FOUND;
    IF v_ok THEN
      INSERT INTO auth_email_requests (purpose, email) SELECT 'recovery_code_used', u.email FROM users u WHERE u.id = v_user;
    END IF;
  ELSE
    SELECT id INTO v_factor FROM mfa_factors WHERE user_id = v_user AND type = 'totp' AND confirmed_at IS NOT NULL;
    v_ok := v_factor IS NOT NULL AND auth_totp_check(v_factor, p_code);
  END IF;
  INSERT INTO mfa_attempts (user_id, ok) VALUES (v_user, v_ok);
  IF v_ok THEN UPDATE sessions SET mfa_verified_at = now() WHERE id = v_session; END IF;
  RETURN v_ok;
END $$;
