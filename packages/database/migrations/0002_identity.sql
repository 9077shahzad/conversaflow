-- 0002 Identity: people, credentials, MFA, sessions, one-time tokens.
-- A user is a person and may belong to several companies (tenants), so these tables are global.
-- They are still protected by row-level security: a user sees their own row, plus the people
-- who share the company they are currently working in.

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  email             citext NOT NULL UNIQUE CHECK (length(email) <= 254 AND email LIKE '%_@_%'),
  full_name         text   NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  locale            text   NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar')),
  email_verified_at timestamptz,
  status            text   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_credentials (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_factors (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('totp')),
  secret_enc   text NOT NULL,              -- AES-256-GCM, key held outside the database
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, type)
);

CREATE TABLE mfa_recovery_codes (
  id        uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL,
  used_at   timestamptz
);
CREATE INDEX ON mfa_recovery_codes (user_id);

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  token_hash       bytea NOT NULL UNIQUE,  -- SHA-256 of the cookie value; the value itself is never stored
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_tenant_id uuid,
  mfa_verified_at  timestamptz,
  ip               inet,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz
);
CREATE INDEX ON sessions (user_id);

CREATE TABLE auth_tokens (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Row-level security ---------------------------------------------------------------------------
ALTER TABLE users              ENABLE ROW LEVEL SECURITY; ALTER TABLE users              FORCE ROW LEVEL SECURITY;
ALTER TABLE user_credentials   ENABLE ROW LEVEL SECURITY; ALTER TABLE user_credentials   FORCE ROW LEVEL SECURITY;
ALTER TABLE mfa_factors        ENABLE ROW LEVEL SECURITY; ALTER TABLE mfa_factors        FORCE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY; ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions           ENABLE ROW LEVEL SECURITY; ALTER TABLE sessions           FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens        ENABLE ROW LEVEL SECURITY; ALTER TABLE auth_tokens        FORCE ROW LEVEL SECURITY;

-- users: own row, or people in the company currently selected (policy added in 0003 once memberships exist).
CREATE POLICY users_self_update ON users FOR UPDATE TO cf_app
  USING (id = app_user_id()) WITH CHECK (id = app_user_id());
CREATE POLICY credentials_self ON user_credentials FOR ALL TO cf_app
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY mfa_self ON mfa_factors FOR ALL TO cf_app
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY recovery_self ON mfa_recovery_codes FOR ALL TO cf_app
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY sessions_self ON sessions FOR ALL TO cf_app
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
-- auth_tokens: no cf_app policy at all. Only the authentication functions below can touch them.

-- cf_auth owns the narrow functions used before a user is known (sign-up, login, token checks).
-- cf_app can call them but can never become cf_auth.
CREATE POLICY auth_users       ON users            FOR ALL TO cf_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_credentials ON user_credentials FOR ALL TO cf_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_sessions    ON sessions         FOR ALL TO cf_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_tokens_all  ON auth_tokens      FOR ALL TO cf_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_mfa         ON mfa_factors      FOR SELECT TO cf_auth USING (true);

GRANT SELECT, UPDATE ON users TO cf_app;
GRANT SELECT, INSERT, UPDATE ON user_credentials, mfa_factors, mfa_recovery_codes, sessions TO cf_app;
GRANT DELETE ON mfa_factors, mfa_recovery_codes TO cf_app;
GRANT SELECT, INSERT, UPDATE ON users, user_credentials, sessions, auth_tokens TO cf_auth;
GRANT SELECT ON mfa_factors TO cf_auth;

-- Authentication functions (SECURITY DEFINER, owned by cf_auth) ---------------------------------

CREATE FUNCTION auth_register_user(p_email citext, p_full_name text, p_locale text, p_password_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO users (email, full_name, locale) VALUES (p_email, p_full_name, p_locale)
  ON CONFLICT (email) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN NULL; END IF;  -- caller answers identically either way (no account enumeration)
  INSERT INTO user_credentials (user_id, password_hash) VALUES (v_id, p_password_hash);
  RETURN v_id;
END $$;

CREATE FUNCTION auth_credentials_by_email(p_email citext)
RETURNS TABLE (user_id uuid, password_hash text, status text, email_verified boolean, has_mfa boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, c.password_hash, u.status, u.email_verified_at IS NOT NULL,
         EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL)
  FROM users u JOIN user_credentials c ON c.user_id = u.id
  WHERE u.email = p_email
$$;

CREATE FUNCTION auth_session_lookup(p_token_hash bytea)
RETURNS TABLE (session_id uuid, user_id uuid, active_tenant_id uuid, mfa_verified_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  UPDATE sessions s SET last_seen_at = now()
  FROM users u
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
    AND u.id = s.user_id AND u.status = 'active'
  RETURNING s.id, s.user_id, s.active_tenant_id, s.mfa_verified_at, s.expires_at;
END $$;

CREATE FUNCTION auth_issue_token(p_user_id uuid, p_purpose text, p_token_hash bytea, p_ttl interval)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE auth_tokens SET used_at = now() WHERE user_id = p_user_id AND purpose = p_purpose AND used_at IS NULL;
  INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (p_user_id, p_purpose, p_token_hash, now() + p_ttl);
$$;

CREATE FUNCTION auth_user_id_by_email(p_email citext) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM users WHERE email = p_email AND status = 'active'
$$;

CREATE FUNCTION auth_verify_email(p_token_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  UPDATE auth_tokens SET used_at = now()
  WHERE token_hash = p_token_hash AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > now()
  RETURNING user_id INTO v_user;
  IF v_user IS NOT NULL THEN
    UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = v_user;
  END IF;
  RETURN v_user;
END $$;

-- Resets the password and revokes every existing session in one step.
CREATE FUNCTION auth_reset_password(p_token_hash bytea, p_password_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  UPDATE auth_tokens SET used_at = now()
  WHERE token_hash = p_token_hash AND purpose = 'reset_password' AND used_at IS NULL AND expires_at > now()
  RETURNING user_id INTO v_user;
  IF v_user IS NOT NULL THEN
    UPDATE user_credentials SET password_hash = p_password_hash, changed_at = now() WHERE user_id = v_user;
    UPDATE sessions SET revoked_at = now() WHERE user_id = v_user AND revoked_at IS NULL;
  END IF;
  RETURN v_user;
END $$;

ALTER FUNCTION auth_register_user(citext, text, text, text) OWNER TO cf_auth;
ALTER FUNCTION auth_credentials_by_email(citext)            OWNER TO cf_auth;
ALTER FUNCTION auth_session_lookup(bytea)                   OWNER TO cf_auth;
ALTER FUNCTION auth_issue_token(uuid, text, bytea, interval) OWNER TO cf_auth;
ALTER FUNCTION auth_user_id_by_email(citext)                OWNER TO cf_auth;
ALTER FUNCTION auth_verify_email(bytea)                     OWNER TO cf_auth;
ALTER FUNCTION auth_reset_password(bytea, text)             OWNER TO cf_auth;

REVOKE ALL ON FUNCTION auth_register_user(citext, text, text, text), auth_credentials_by_email(citext),
  auth_session_lookup(bytea), auth_issue_token(uuid, text, bytea, interval), auth_user_id_by_email(citext),
  auth_verify_email(bytea), auth_reset_password(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_register_user(citext, text, text, text), auth_credentials_by_email(citext),
  auth_session_lookup(bytea), auth_issue_token(uuid, text, bytea, interval), auth_user_id_by_email(citext),
  auth_verify_email(bytea), auth_reset_password(bytea, text) TO cf_app;
