-- 0016 M7: a new authenticator activates only after a code emailed to the account's verified address is entered in
-- the SAME session that started set-up (docs/readiness/pilot-mfa-residual-risk.md).
--
-- Flow:  auth_mfa_begin (unchanged) -> auth_mfa_confirm_code (first authenticator code; queues the email)
--        -> notifier: auth_mfa_issue_activation (only cf_notify; destination read here, from users, never passed in)
--        -> auth_mfa_activate (emailed code + recovery-code hashes, from the enrolling session) -> factor confirmed.
-- A holder of the sign-in credential (cf_identity) can start set-up but cannot see, create or redirect the emailed
-- code, and a code is useless outside the session that started set-up.

ALTER TABLE mfa_factors ADD COLUMN code_verified_at timestamptz;
ALTER TABLE mfa_factors ADD COLUMN enrol_session_id uuid REFERENCES sessions(id) ON DELETE CASCADE;

CREATE TABLE mfa_activation_codes (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  factor_id   uuid NOT NULL REFERENCES mfa_factors(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  code_hash   bytea NOT NULL CHECK (length(code_hash) = 32),
  sent_to     citext NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mfa_activation_codes ENABLE ROW LEVEL SECURITY; ALTER TABLE mfa_activation_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_activation ON mfa_activation_codes FOR ALL TO cf_auth USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON mfa_activation_codes TO cf_auth;

-- Email requests can now name the factor to confirm. Only the authentication functions queue this purpose.
ALTER TABLE auth_email_requests ADD COLUMN factor_id uuid REFERENCES mfa_factors(id) ON DELETE CASCADE;
ALTER TABLE auth_email_requests DROP CONSTRAINT auth_email_requests_purpose_check;
ALTER TABLE auth_email_requests ADD CONSTRAINT auth_email_requests_purpose_check
  CHECK (purpose IN ('verify_email', 'reset_password', 'signup_existing', 'mfa_enabled', 'recovery_code_used', 'mfa_activate', 'mfa_reset'));
ALTER TABLE auth_email_requests ADD CONSTRAINT auth_email_requests_activation_names_factor
  CHECK (purpose <> 'mfa_activate' OR factor_id IS NOT NULL);
CREATE POLICY auth_requests_read ON auth_email_requests FOR SELECT TO cf_auth USING (true);
GRANT SELECT (id, purpose, factor_id, processed_at) ON auth_email_requests TO cf_auth;

-- The old one-step confirmation is withdrawn: nothing may confirm a factor without the emailed code.
DROP FUNCTION auth_mfa_confirm(bytea, text, bytea[]);

-- Step 2: the first authenticator code. Marks the factor code-verified for THIS session and queues the email.
CREATE FUNCTION auth_mfa_confirm_code(p_token_hash bytea, p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_session uuid; v_user uuid; v_factor uuid; v_ok boolean; v_email citext; v_verified timestamptz;
BEGIN
  SELECT session_id, user_id INTO v_session, v_user FROM auth_session_from_token(p_token_hash);
  IF v_user IS NULL THEN RAISE EXCEPTION 'no active session' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT email, email_verified_at INTO v_email, v_verified FROM users WHERE id = v_user;
  IF v_verified IS NULL THEN RAISE EXCEPTION 'email address not verified' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM auth_mfa_guard(v_user);
  SELECT id INTO v_factor FROM mfa_factors WHERE user_id = v_user AND type = 'totp' AND confirmed_at IS NULL;
  v_ok := v_factor IS NOT NULL AND auth_totp_check(v_factor, p_code);
  INSERT INTO mfa_attempts (user_id, ok) VALUES (v_user, v_ok);
  IF NOT v_ok THEN RETURN false; END IF;
  UPDATE mfa_factors SET code_verified_at = now(), enrol_session_id = v_session WHERE id = v_factor;
  UPDATE mfa_activation_codes SET used_at = now() WHERE factor_id = v_factor AND used_at IS NULL;
  INSERT INTO auth_email_requests (purpose, email, factor_id) VALUES ('mfa_activate', v_email, v_factor);
  RETURN true;
END $$;

-- Notifier only: records the hash of the code it is about to email and returns the destination, read here from the
-- user's stored, verified address. Returns NULL (nothing to send) if the request is not a live activation.
CREATE FUNCTION auth_mfa_issue_activation(p_request uuid, p_code_hash bytea) RETURNS citext
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_factor uuid; f mfa_factors%ROWTYPE; v_email citext;
BEGIN
  IF length(p_code_hash) <> 32 THEN RAISE EXCEPTION 'code hash must be SHA-256' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT factor_id INTO v_factor FROM auth_email_requests WHERE id = p_request AND purpose = 'mfa_activate' AND processed_at IS NULL;
  IF v_factor IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO f FROM mfa_factors WHERE id = v_factor AND confirmed_at IS NULL AND code_verified_at IS NOT NULL FOR UPDATE;
  IF f.id IS NULL OR f.enrol_session_id IS NULL THEN RETURN NULL; END IF;
  SELECT email INTO v_email FROM users WHERE id = f.user_id AND email_verified_at IS NOT NULL AND status = 'active';
  IF v_email IS NULL THEN RETURN NULL; END IF;
  UPDATE mfa_activation_codes SET used_at = now() WHERE factor_id = f.id AND used_at IS NULL;
  INSERT INTO mfa_activation_codes (factor_id, user_id, session_id, code_hash, sent_to, expires_at)
  VALUES (f.id, f.user_id, f.enrol_session_id, p_code_hash, v_email, now() + interval '15 minutes');
  RETURN v_email;
END $$;

-- Step 3: the emailed code, entered in the session that started set-up. Confirms the factor, stores the recovery
-- codes (hashes), marks THIS session verified, ends every other session and sends the "turned on" notice.
CREATE FUNCTION auth_mfa_activate(p_token_hash bytea, p_code_hash bytea, p_recovery_hashes bytea[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_session uuid; v_user uuid; v_factor uuid; v_code uuid; v_ok boolean := false;
BEGIN
  SELECT session_id, user_id INTO v_session, v_user FROM auth_session_from_token(p_token_hash);
  IF v_user IS NULL THEN RAISE EXCEPTION 'no active session' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF cardinality(p_recovery_hashes) <> 10 OR EXISTS (SELECT 1 FROM unnest(p_recovery_hashes) h WHERE length(h) <> 32) THEN
    RAISE EXCEPTION 'ten SHA-256 recovery code hashes are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM auth_mfa_guard(v_user);
  SELECT id INTO v_factor FROM mfa_factors
  WHERE user_id = v_user AND type = 'totp' AND confirmed_at IS NULL AND code_verified_at IS NOT NULL AND enrol_session_id = v_session
  FOR UPDATE;
  IF v_factor IS NOT NULL THEN
    SELECT id INTO v_code FROM mfa_activation_codes
    WHERE factor_id = v_factor AND session_id = v_session AND code_hash = p_code_hash AND used_at IS NULL AND expires_at > now()
    FOR UPDATE;
    v_ok := v_code IS NOT NULL;
  END IF;
  INSERT INTO mfa_attempts (user_id, ok) VALUES (v_user, v_ok);
  IF NOT v_ok THEN RETURN false; END IF;
  UPDATE mfa_activation_codes SET used_at = now() WHERE id = v_code;
  UPDATE mfa_factors SET confirmed_at = now() WHERE id = v_factor;
  DELETE FROM mfa_recovery_codes WHERE user_id = v_user;
  INSERT INTO mfa_recovery_codes (user_id, code_hash) SELECT v_user, h FROM unnest(p_recovery_hashes) h;
  UPDATE sessions SET mfa_verified_at = now() WHERE id = v_session;
  UPDATE sessions SET revoked_at = now(), revoke_reason = 'mfa_enabled' WHERE user_id = v_user AND revoked_at IS NULL AND id <> v_session;
  INSERT INTO auth_email_requests (purpose, email) SELECT 'mfa_enabled', u.email FROM users u WHERE u.id = v_user;
  RETURN true;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['auth_mfa_confirm_code(bytea,text)', 'auth_mfa_issue_activation(uuid,bytea)',
                           'auth_mfa_activate(bytea,bytea,bytea[])'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO cf_auth', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION auth_mfa_confirm_code(bytea, text), auth_mfa_activate(bytea, bytea, bytea[]) TO cf_identity;
GRANT EXECUTE ON FUNCTION auth_mfa_issue_activation(uuid, bytea) TO cf_notify;
