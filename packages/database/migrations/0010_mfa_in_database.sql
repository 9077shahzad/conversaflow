-- 0010 Two-step verification decided inside the database (independent recheck, finding N1; also N2 and N3).
--
-- Finding: the sign-in role (cf_identity) could open a session for any user and then mark it "MFA verified" with a
-- plain UPDATE, because row security trusted app.user_id, which the role sets for itself. With the platform
-- credential as well, that approved support grants; against a customer it opened MFA-protected data.
-- Fix: cf_identity loses every write on MFA data and on sessions.mfa_verified_at. A session can be marked verified
-- only by auth_mfa_verify / auth_mfa_confirm, which identify the user FROM THE SESSION TOKEN and check a real TOTP
-- or recovery code. TOTP secrets are sealed with a key that only the authentication functions (cf_auth) can read,
-- so neither the API nor its database roles can compute codes. Wrong guesses are limited in the database too.
--
-- Residual (accepted, ADR-027): cf_identity can still open a session WITHOUT verified MFA for any user, because
-- password checking (Argon2id) happens in the API. For users with MFA that session can do nothing but the MFA step.

-- 1. A key only the authentication functions can read ------------------------------------------------
CREATE TABLE auth_keys (
  id       smallint PRIMARY KEY CHECK (id = 1),
  totp_key text NOT NULL
);
INSERT INTO auth_keys (id, totp_key) VALUES (1, encode(gen_random_bytes(32), 'hex'));
ALTER TABLE auth_keys ENABLE ROW LEVEL SECURITY; ALTER TABLE auth_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_keys_read ON auth_keys FOR SELECT TO cf_auth USING (true);
GRANT SELECT ON auth_keys TO cf_auth;

-- 2. Sealed secrets and a database-side attempt log ------------------------------------------------
ALTER TABLE mfa_factors ALTER COLUMN secret_enc DROP NOT NULL;
ALTER TABLE mfa_factors ADD COLUMN secret_sealed bytea;
-- Factors created before this migration (only ever in disposable local databases) cannot be checked by the database:
-- they stay in place, so the account keeps requiring MFA, and operations must reset them (runbook).
COMMENT ON COLUMN mfa_factors.secret_enc IS 'Legacy (API-encrypted) secret; unused from migration 0010';

CREATE TABLE mfa_attempts (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ok      boolean NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON mfa_attempts (user_id, at);
ALTER TABLE mfa_attempts ENABLE ROW LEVEL SECURITY; ALTER TABLE mfa_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_attempts ON mfa_attempts FOR ALL TO cf_auth USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON mfa_attempts TO cf_auth;

-- 3. TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits) and base32 (RFC 4648) in SQL --------------
CREATE FUNCTION base32_encode(b bytea) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE alphabet text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; out text := ''; buf int := 0; bits int := 0;
BEGIN
  FOR i IN 0 .. length(b) - 1 LOOP
    buf := ((buf << 8) | get_byte(b, i)) & 65535;
    bits := bits + 8;
    WHILE bits >= 5 LOOP
      out := out || substr(alphabet, ((buf >> (bits - 5)) & 31) + 1, 1);
      bits := bits - 5;
    END LOOP;
  END LOOP;
  IF bits > 0 THEN out := out || substr(alphabet, ((buf << (5 - bits)) & 31) + 1, 1); END IF;
  RETURN out;
END $$;

CREATE FUNCTION base32_decode(t text) RETURNS bytea LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE alphabet text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; s text := upper(replace(t, '=', ''));
        out bytea := ''::bytea; buf int := 0; bits int := 0; v int;
BEGIN
  FOR i IN 1 .. length(s) LOOP
    v := strpos(alphabet, substr(s, i, 1)) - 1;
    IF v < 0 THEN RAISE EXCEPTION 'invalid base32' USING ERRCODE = 'invalid_parameter_value'; END IF;
    buf := ((buf << 5) | v) & 65535;
    bits := bits + 5;
    IF bits >= 8 THEN
      out := out || set_byte('\x00'::bytea, 0, (buf >> (bits - 8)) & 255);
      bits := bits - 8;
    END IF;
  END LOOP;
  RETURN out;
END $$;

CREATE FUNCTION totp_at(secret bytea, step bigint) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE msg bytea := '\x0000000000000000'::bytea; h bytea; o int; bin bigint;
BEGIN
  FOR i IN 0 .. 7 LOOP msg := set_byte(msg, 7 - i, ((step >> (8 * i)) & 255)::int); END LOOP;
  h := hmac(msg, secret, 'sha1');
  o := get_byte(h, 19) & 15;
  bin := ((get_byte(h, o) & 127)::bigint << 24) | (get_byte(h, o + 1)::bigint << 16)
       | (get_byte(h, o + 2)::bigint << 8) | get_byte(h, o + 3)::bigint;
  RETURN lpad((bin % 1000000)::text, 6, '0');
END $$;

-- 4. Authentication functions, owned by cf_auth --------------------------------------------------------

-- A live session, identified by its token hash (never by app.user_id).
CREATE FUNCTION auth_session_from_token(p_token_hash bytea, OUT session_id uuid, OUT user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.user_id FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
    AND s.created_at > now() - interval '12 hours' AND s.last_seen_at > now() - interval '24 hours'
    AND u.status = 'active'
$$;

-- Starts enrolment for a user with no confirmed factor. Returns the base32 secret once, to show as a QR code.
CREATE FUNCTION auth_mfa_begin(p_token_hash bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid; v_secret bytea := gen_random_bytes(20); v_key text;
BEGIN
  SELECT user_id INTO v_user FROM auth_session_from_token(p_token_hash);
  IF v_user IS NULL THEN RAISE EXCEPTION 'no active session' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF EXISTS (SELECT 1 FROM mfa_factors WHERE user_id = v_user AND confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'two-step verification is already on' USING ERRCODE = 'unique_violation';
  END IF;
  SELECT totp_key INTO v_key FROM auth_keys WHERE id = 1;
  DELETE FROM mfa_factors WHERE user_id = v_user AND confirmed_at IS NULL;
  INSERT INTO mfa_factors (user_id, type, secret_sealed) VALUES (v_user, 'totp', pgp_sym_encrypt_bytea(v_secret, v_key));
  RETURN base32_encode(v_secret);
END $$;

-- Internal: checks a code against a factor, with replay protection. Returns true and records the step on success.
CREATE FUNCTION auth_totp_check(p_factor uuid, p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f mfa_factors%ROWTYPE; v_key text; v_secret bytea; v_now bigint := floor(extract(epoch FROM clock_timestamp()) / 30);
BEGIN
  IF p_code IS NULL OR p_code !~ '^\d{6}$' THEN RETURN false; END IF;
  SELECT * INTO f FROM mfa_factors WHERE id = p_factor FOR UPDATE;
  IF f.secret_sealed IS NULL THEN RETURN false; END IF;  -- legacy factor: must be reset by operations
  SELECT totp_key INTO v_key FROM auth_keys WHERE id = 1;
  v_secret := pgp_sym_decrypt_bytea(f.secret_sealed, v_key);
  FOR d IN -1 .. 1 LOOP
    IF totp_at(v_secret, v_now + d) = p_code THEN
      IF f.last_used_step IS NOT NULL AND v_now + d <= f.last_used_step THEN RETURN false; END IF;  -- each code once
      UPDATE mfa_factors SET last_used_step = v_now + d WHERE id = p_factor;
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END $$;

-- Database-side guessing limit: at most 10 wrong attempts per user per hour, whatever the caller.
CREATE FUNCTION auth_mfa_guard(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text || ':mfa', 11));
  IF (SELECT count(*) FROM mfa_attempts WHERE user_id = p_user AND NOT ok AND at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'too many two-step verification attempts' USING ERRCODE = 'program_limit_exceeded';
  END IF;
END $$;

-- Confirms enrolment with a first code, stores the recovery codes (hashes), marks THIS session verified and
-- ends every other session of the user.
CREATE FUNCTION auth_mfa_confirm(p_token_hash bytea, p_code text, p_recovery_hashes bytea[]) RETURNS boolean
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
  RETURN true;
END $$;

-- The second sign-in step: a TOTP code OR a recovery code (each recovery code works exactly once, even when
-- two requests race). Marks only the session the token belongs to.
CREATE FUNCTION auth_mfa_verify(p_token_hash bytea, p_code text, p_recovery_hash bytea) RETURNS boolean
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
  ELSE
    SELECT id INTO v_factor FROM mfa_factors WHERE user_id = v_user AND type = 'totp' AND confirmed_at IS NOT NULL;
    v_ok := v_factor IS NOT NULL AND auth_totp_check(v_factor, p_code);
  END IF;
  INSERT INTO mfa_attempts (user_id, ok) VALUES (v_user, v_ok);
  IF v_ok THEN UPDATE sessions SET mfa_verified_at = now() WHERE id = v_session; END IF;
  RETURN v_ok;
END $$;

-- 5. Privileges --------------------------------------------------------------------------------------
-- cf_auth (function owner) needs to manage MFA rows and read users/sessions.
GRANT INSERT, UPDATE, DELETE ON mfa_factors TO cf_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_codes TO cf_auth;
CREATE POLICY auth_mfa_all ON mfa_factors FOR ALL TO cf_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_recovery_all ON mfa_recovery_codes FOR ALL TO cf_auth USING (true) WITH CHECK (true);

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['auth_session_from_token(bytea)', 'auth_mfa_begin(bytea)', 'auth_totp_check(uuid,text)',
    'auth_mfa_guard(uuid)', 'auth_mfa_confirm(bytea,text,bytea[])', 'auth_mfa_verify(bytea,text,bytea)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO cf_auth', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION base32_encode(bytea), base32_decode(text), totp_at(bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION base32_encode(bytea), base32_decode(text), totp_at(bytea, bigint) TO cf_auth;
GRANT EXECUTE ON FUNCTION auth_mfa_begin(bytea), auth_mfa_confirm(bytea, text, bytea[]), auth_mfa_verify(bytea, text, bytea)
  TO cf_identity;

-- cf_identity: no writes to MFA data, no reading secrets or recovery codes, no marking sessions verified.
REVOKE ALL ON mfa_factors, mfa_recovery_codes FROM cf_identity;
GRANT SELECT (id, user_id, type, confirmed_at) ON mfa_factors TO cf_identity;   -- "does this user have MFA?"
REVOKE UPDATE ON sessions FROM cf_identity;
GRANT UPDATE (active_tenant_id, revoked_at, revoke_reason, last_seen_at) ON sessions TO cf_identity;

-- 6. Platform staff sessions (finding N2): active user, 60-minute idle limit, 12-hour absolute limit --------
GRANT SELECT (created_at) ON sessions TO cf_ops;
CREATE OR REPLACE FUNCTION platform_session_staff(p_token text, OUT user_id uuid, OUT role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.user_id, ps.role
  FROM sessions s
  JOIN platform_staff ps ON ps.user_id = s.user_id
  JOIN users u ON u.id = s.user_id AND u.status = 'active'
  WHERE s.token_hash = digest(convert_to(p_token, 'UTF8'), 'sha256')
    AND s.revoked_at IS NULL AND s.expires_at > now() AND s.mfa_verified_at IS NOT NULL
    AND s.created_at > now() - interval '12 hours'
    AND s.last_seen_at > now() - interval '60 minutes'
$$;
