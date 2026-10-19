-- 0006 Credential separation and session expiry (pre-pilot security items).
--
-- Before: the API's database role (cf_app) could write password hashes, MFA factors and recovery codes,
-- create sessions, and mint email-verification / password-reset tokens. A SQL-injection flaw anywhere in the
-- business code could therefore be turned into an account takeover.
-- After: cf_app has no rights over credentials at all.
--   cf_identity  sign-in, sessions and MFA — used only by the authentication module's own connection pool.
--   cf_notify    the notifier worker — the ONLY role that can issue email tokens; it can read nothing else.
-- Roles are created by the migration runner (passwords come from the environment).

-- Why a session ended (also used by session expiry below).
ALTER TABLE sessions ADD COLUMN revoke_reason text
  CHECK (revoke_reason IN ('logout', 'revoked_by_user', 'idle', 'password_reset', 'mfa_enabled', 'removed'));

GRANT USAGE ON SCHEMA public TO cf_identity, cf_notify;
GRANT EXECUTE ON FUNCTION uuid_generate_v7(), app_tenant_id(), app_user_id() TO cf_identity, cf_notify;

-- 1. Take every credential right away from cf_app ------------------------------------------------
REVOKE ALL ON user_credentials, mfa_factors, mfa_recovery_codes, auth_tokens FROM cf_app;
REVOKE ALL ON sessions FROM cf_app;
-- The business API may only read which company a session is in, and switch it.
GRANT SELECT (id, user_id, active_tenant_id) ON sessions TO cf_app;
GRANT UPDATE (active_tenant_id) ON sessions TO cf_app;
REVOKE EXECUTE ON FUNCTION
  auth_register_user(citext, text, text, text), auth_credentials_by_email(citext), auth_session_lookup(bytea),
  auth_issue_token(uuid, text, bytea, interval), auth_user_id_by_email(citext), auth_verify_email(bytea),
  auth_reset_password(bytea, text)
FROM cf_app;

-- 2. Identity role --------------------------------------------------------------------------------
GRANT SELECT ON users TO cf_identity;
GRANT SELECT ON memberships TO cf_identity;
GRANT SELECT, INSERT, DELETE ON mfa_factors, mfa_recovery_codes TO cf_identity;
GRANT UPDATE (confirmed_at, last_used_step) ON mfa_factors TO cf_identity;
GRANT UPDATE (used_at) ON mfa_recovery_codes TO cf_identity;
GRANT SELECT, INSERT ON sessions TO cf_identity;
GRANT UPDATE (active_tenant_id, mfa_verified_at, revoked_at, revoke_reason, last_seen_at) ON sessions TO cf_identity;

CREATE POLICY identity_users_self    ON users              FOR SELECT TO cf_identity USING (id = app_user_id());
CREATE POLICY identity_memberships   ON memberships        FOR SELECT TO cf_identity USING (user_id = app_user_id());
CREATE POLICY identity_mfa_self      ON mfa_factors        FOR ALL TO cf_identity
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY identity_recovery_self ON mfa_recovery_codes FOR ALL TO cf_identity
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY identity_sessions_self ON sessions           FOR ALL TO cf_identity
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());

-- 3. Session expiry: idle timeout enforced inside the lookup ----------------------------------------

DROP FUNCTION auth_session_lookup(bytea);
CREATE FUNCTION auth_session_lookup(p_token_hash bytea, p_idle interval)
RETURNS TABLE (session_id uuid, user_id uuid, active_tenant_id uuid, mfa_verified_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_idle < interval '5 minutes' OR p_idle > interval '24 hours' THEN
    RAISE EXCEPTION 'idle timeout out of range' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- A session unused for longer than the idle timeout is ended for good, not just refused.
  UPDATE sessions SET revoked_at = now(), revoke_reason = 'idle'
  WHERE token_hash = p_token_hash AND revoked_at IS NULL AND last_seen_at < now() - p_idle;
  RETURN QUERY
  UPDATE sessions s SET last_seen_at = now()
  FROM users u
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
    AND u.id = s.user_id AND u.status = 'active'
  RETURNING s.id, s.user_id, s.active_tenant_id, s.mfa_verified_at, s.expires_at;
END $$;
ALTER FUNCTION auth_session_lookup(bytea, interval) OWNER TO cf_auth;
REVOKE ALL ON FUNCTION auth_session_lookup(bytea, interval) FROM PUBLIC;

-- Password reset also records why the sessions ended.
CREATE OR REPLACE FUNCTION auth_reset_password(p_token_hash bytea, p_password_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  UPDATE auth_tokens SET used_at = now()
  WHERE token_hash = p_token_hash AND purpose = 'reset_password' AND used_at IS NULL AND expires_at > now()
  RETURNING user_id INTO v_user;
  IF v_user IS NOT NULL THEN
    UPDATE user_credentials SET password_hash = p_password_hash, changed_at = now() WHERE user_id = v_user;
    UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_reset' WHERE user_id = v_user AND revoked_at IS NULL;
  END IF;
  RETURN v_user;
END $$;

-- 4. Account emails go through a request queue; only the notifier can mint the tokens -------------
CREATE TABLE auth_email_requests (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  purpose      text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'signup_existing')),
  email        citext NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts     int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error   text
);
CREATE INDEX ON auth_email_requests (next_attempt_at) WHERE processed_at IS NULL;
ALTER TABLE auth_email_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE auth_email_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_requests_insert ON auth_email_requests FOR INSERT TO cf_auth WITH CHECK (true);
CREATE POLICY notify_requests      ON auth_email_requests FOR ALL TO cf_notify USING (true) WITH CHECK (true);
GRANT INSERT ON auth_email_requests TO cf_auth;
GRANT SELECT ON auth_email_requests TO cf_notify;
GRANT UPDATE (processed_at, attempts, next_attempt_at, last_error) ON auth_email_requests TO cf_notify;

CREATE FUNCTION auth_request_email(p_purpose text, p_email citext) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO auth_email_requests (purpose, email) VALUES (p_purpose, p_email);
$$;
ALTER FUNCTION auth_request_email(text, citext) OWNER TO cf_auth;
REVOKE ALL ON FUNCTION auth_request_email(text, citext) FROM PUBLIC;

-- 5. Who may call what ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  auth_register_user(citext, text, text, text), auth_credentials_by_email(citext),
  auth_session_lookup(bytea, interval), auth_verify_email(bytea), auth_reset_password(bytea, text),
  auth_request_email(text, citext)
TO cf_identity;
GRANT EXECUTE ON FUNCTION auth_issue_token(uuid, text, bytea, interval), auth_user_id_by_email(citext) TO cf_notify;

-- The owner role (operations) may end sessions, e.g. after an incident.
CREATE POLICY sessions_owner ON sessions FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
