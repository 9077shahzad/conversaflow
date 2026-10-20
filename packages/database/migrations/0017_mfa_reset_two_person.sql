-- 0017 M8: audited reset of two-step sign-in for a user who has lost the authenticator and all recovery codes.
-- Two DISTINCT platform owners: one records the identity check and requests the reset, the other approves it.
-- On approval the user's factors, recovery codes and pending confirmation codes are removed, every session is ended,
-- and a notice goes to the stored address. The user then sets up two-step sign-in again (with M7's email check).
-- No identity document numbers are stored: only the method and a short reference.

CREATE TABLE mfa_reset_requests (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by       uuid NOT NULL REFERENCES users(id),
  reason             text NOT NULL CHECK (length(trim(reason)) BETWEEN 20 AND 1000),
  identity_method    text NOT NULL CHECK (identity_method IN
                       ('video_call_photo_id', 'callback_known_number', 'company_owner_confirmation', 'in_person')),
  -- A short note of what was checked, e.g. "video call 10:20 GST, matched profile photo". Six or more digits in a row
  -- are refused so document or account numbers cannot be stored here.
  identity_reference text NOT NULL CHECK (length(trim(identity_reference)) BETWEEN 10 AND 200 AND identity_reference !~ '[0-9]{6,}'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  rejected_by        uuid REFERENCES users(id),
  rejected_at        timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (requested_by <> user_id AND (approved_by IS NULL OR approved_by <> user_id))
);
CREATE UNIQUE INDEX mfa_reset_one_open ON mfa_reset_requests (user_id) WHERE approved_at IS NULL AND rejected_at IS NULL;
ALTER TABLE mfa_reset_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE mfa_reset_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY ops_reset_read   ON mfa_reset_requests FOR SELECT TO cf_ops USING (true);
CREATE POLICY ops_reset_insert ON mfa_reset_requests FOR INSERT TO cf_ops WITH CHECK (true);
CREATE POLICY ops_reset_decide ON mfa_reset_requests FOR UPDATE TO cf_ops
  USING (approved_at IS NULL AND rejected_at IS NULL) WITH CHECK (true);
GRANT SELECT ON mfa_reset_requests TO cf_ops;
GRANT INSERT (user_id, requested_by, reason, identity_method, identity_reference) ON mfa_reset_requests TO cf_ops;
GRANT UPDATE (approved_by, approved_at, rejected_by, rejected_at) ON mfa_reset_requests TO cf_ops;

ALTER TABLE sessions DROP CONSTRAINT sessions_revoke_reason_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_revoke_reason_check
  CHECK (revoke_reason IN ('logout', 'revoked_by_user', 'idle', 'password_reset', 'mfa_enabled', 'removed', 'mfa_reset'));

-- Internal, owned by cf_auth, callable ONLY by cf_ops (inside the approval function below).
CREATE FUNCTION auth_mfa_reset_execute(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM mfa_activation_codes WHERE user_id = p_user;
  DELETE FROM mfa_recovery_codes WHERE user_id = p_user;
  DELETE FROM mfa_factors WHERE user_id = p_user;
  DELETE FROM mfa_attempts WHERE user_id = p_user;
  UPDATE sessions SET revoked_at = now(), revoke_reason = 'mfa_reset' WHERE user_id = p_user AND revoked_at IS NULL;
  INSERT INTO auth_email_requests (purpose, email) SELECT 'mfa_reset', u.email FROM users u WHERE u.id = p_user;
END $$;
GRANT DELETE ON mfa_attempts TO cf_auth;
GRANT DELETE ON mfa_activation_codes TO cf_auth;
CREATE POLICY auth_attempts_delete ON mfa_attempts FOR DELETE TO cf_auth USING (true);

CREATE FUNCTION platform_request_mfa_reset(p_token text, p_email citext, p_reason text, p_method text, p_reference text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_user uuid; v_id uuid;
BEGIN
  SELECT id INTO v_user FROM users WHERE email = p_email;
  IF v_user IS NULL THEN RAISE EXCEPTION 'no account with that email' USING ERRCODE = 'check_violation'; END IF;
  IF v_user = v_staff THEN RAISE EXCEPTION 'you cannot request a reset for your own account' USING ERRCODE = 'check_violation'; END IF;
  UPDATE mfa_reset_requests SET rejected_by = v_staff, rejected_at = now()
  WHERE user_id = v_user AND approved_at IS NULL AND rejected_at IS NULL AND expires_at <= now();  -- clear an expired one
  INSERT INTO mfa_reset_requests (user_id, requested_by, reason, identity_method, identity_reference)
  VALUES (v_user, v_staff, p_reason, p_method, p_reference) RETURNING id INTO v_id;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'mfa_reset.requested', 'user', v_user::text,
          jsonb_build_object('request', v_id, 'method', p_method, 'reference', p_reference));
  RETURN v_id;
END $$;

CREATE FUNCTION platform_approve_mfa_reset(p_token text, p_request uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); r mfa_reset_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM mfa_reset_requests WHERE id = p_request FOR UPDATE;
  IF r.id IS NULL OR r.approved_at IS NOT NULL OR r.rejected_at IS NOT NULL THEN
    RAISE EXCEPTION 'no open reset request' USING ERRCODE = 'check_violation';
  END IF;
  IF r.expires_at <= now() THEN RAISE EXCEPTION 'the request has expired; start a new one' USING ERRCODE = 'check_violation'; END IF;
  IF v_staff = r.requested_by THEN
    RAISE EXCEPTION 'a second platform owner must approve; you requested this reset' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_staff = r.user_id THEN RAISE EXCEPTION 'you cannot approve a reset of your own account' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE mfa_reset_requests SET approved_by = v_staff, approved_at = now() WHERE id = r.id;
  PERFORM auth_mfa_reset_execute(r.user_id);
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'mfa_reset.approved_and_done', 'user', r.user_id::text,
          jsonb_build_object('request', r.id, 'requestedBy', r.requested_by));
  RETURN now();
END $$;

CREATE FUNCTION platform_reject_mfa_reset(p_token text, p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_user uuid;
BEGIN
  UPDATE mfa_reset_requests SET rejected_by = v_staff, rejected_at = now()
  WHERE id = p_request AND approved_at IS NULL AND rejected_at IS NULL RETURNING user_id INTO v_user;
  IF v_user IS NULL THEN RAISE EXCEPTION 'no open reset request' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'mfa_reset.rejected', 'user', v_user::text, jsonb_build_object('request', p_request));
END $$;

DO $$
DECLARE f text;
BEGIN
  EXECUTE 'ALTER FUNCTION auth_mfa_reset_execute(uuid) OWNER TO cf_auth';
  EXECUTE 'REVOKE ALL ON FUNCTION auth_mfa_reset_execute(uuid) FROM PUBLIC';
  FOREACH f IN ARRAY ARRAY['platform_request_mfa_reset(text,citext,text,text,text)', 'platform_approve_mfa_reset(text,uuid)',
                           'platform_reject_mfa_reset(text,uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO cf_ops', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION auth_mfa_reset_execute(uuid) TO cf_ops;
GRANT EXECUTE ON FUNCTION platform_request_mfa_reset(text, citext, text, text, text), platform_approve_mfa_reset(text, uuid),
  platform_reject_mfa_reset(text, uuid) TO cf_platform;
