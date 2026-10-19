-- 0009 Bind privileged database actions to a real signed-in session (second independent review, 19 Oct 2026).
--
-- Finding: database checks that depended on "who is calling" read app.user_id, which any role can set for itself.
-- Someone holding the platform console's database password could therefore approve their own support access.
-- Fix: every platform action now takes the caller's SESSION TOKEN (the secret in their cookie, never stored —
-- only its SHA-256 is). The database derives the staff member from a live, unexpired, MFA-verified session.
-- The platform role keeps no direct access to any company table.

-- 1. Who is calling, proven by a session token ------------------------------------------------------
GRANT SELECT (id, user_id, token_hash, expires_at, revoked_at, mfa_verified_at, last_seen_at) ON sessions TO cf_ops;
CREATE POLICY ops_sessions_read ON sessions FOR SELECT TO cf_ops USING (true);

CREATE FUNCTION platform_session_staff(p_token text, OUT user_id uuid, OUT role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.user_id, ps.role
  FROM sessions s JOIN platform_staff ps ON ps.user_id = s.user_id
  WHERE s.token_hash = digest(convert_to(p_token, 'UTF8'), 'sha256')
    AND s.revoked_at IS NULL AND s.expires_at > now() AND s.mfa_verified_at IS NOT NULL
    AND s.last_seen_at > now() - interval '24 hours'
$$;

-- Internal helper: raises unless the token belongs to staff (optionally of a given role).
CREATE FUNCTION platform_require(p_token text, p_role text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid; v_role text;
BEGIN
  SELECT user_id, role INTO v_user, v_role FROM platform_session_staff(p_token);
  IF v_user IS NULL THEN RAISE EXCEPTION 'not an active platform staff session' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_role IS NOT NULL AND v_role IS DISTINCT FROM p_role THEN
    RAISE EXCEPTION 'requires %', p_role USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_user;
END $$;

-- 2. Replace the platform functions with token-bound versions ----------------------------------------
DROP FUNCTION platform_tenant_directory();
DROP FUNCTION platform_request_support(uuid, text, int);
DROP FUNCTION platform_approve_support(uuid);
DROP FUNCTION platform_revoke_support(uuid);
DROP FUNCTION platform_set_feature_flag(uuid, text, boolean);
DROP FUNCTION platform_publish_plan_version(uuid);

CREATE FUNCTION platform_tenant_directory(p_token text)
RETURNS TABLE (tenant_id uuid, slug text, legal_name text, country text, status text, data_region text, created_at timestamptz,
               plan_code text, plan_version int, subscription_status text, trial_ends_at timestamptz,
               active_members int, files_count int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM platform_require(p_token);
  RETURN QUERY
  SELECT t.id, t.slug::text, t.legal_name, t.country::text, t.status, t.data_region, t.created_at,
         p.code, v.version, s.status, s.trial_ends_at,
         (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active'),
         (SELECT count(*)::int FROM files f WHERE f.tenant_id = t.id)
  FROM tenants t
  LEFT JOIN subscriptions s ON s.tenant_id = t.id
  LEFT JOIN plan_versions v ON v.id = s.plan_version_id
  LEFT JOIN plans p ON p.id = v.plan_id
  ORDER BY t.created_at DESC;
END $$;

CREATE FUNCTION platform_request_support(p_token text, p_tenant uuid, p_reason text, p_minutes int) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token); v_id uuid;
BEGIN
  INSERT INTO support_access_grants (tenant_id, requested_by, reason, duration)
  VALUES (p_tenant, v_staff, p_reason, make_interval(mins => p_minutes)) RETURNING id INTO v_id;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'support.requested', 'tenant', p_tenant::text, jsonb_build_object('grant', v_id, 'minutes', p_minutes, 'reason', p_reason));
  RETURN v_id;
END $$;

CREATE FUNCTION platform_approve_support(p_token text, p_grant uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_exp timestamptz; v_tenant uuid;
BEGIN
  UPDATE support_access_grants SET approved_by = v_staff, approved_at = now(), expires_at = now() + duration
  WHERE id = p_grant AND approved_at IS NULL AND revoked_at IS NULL AND requested_by <> v_staff
    AND requested_at > now() - interval '24 hours'
  RETURNING expires_at, tenant_id INTO v_exp, v_tenant;
  IF v_exp IS NULL THEN RAISE EXCEPTION 'grant cannot be approved (missing, already decided, stale, or your own request)' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'support.approved', 'tenant', v_tenant::text, jsonb_build_object('grant', p_grant, 'expires_at', v_exp));
  INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, metadata, hash)
  VALUES (v_tenant, NULL, 'support.access_granted', 'support_grant', p_grant::text, jsonb_build_object('expires_at', v_exp), ''::bytea);
  RETURN v_exp;
END $$;

CREATE FUNCTION platform_revoke_support(p_token text, p_grant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token); v_tenant uuid;
BEGIN
  UPDATE support_access_grants SET revoked_at = now() WHERE id = p_grant AND revoked_at IS NULL RETURNING tenant_id INTO v_tenant;
  IF v_tenant IS NOT NULL THEN
    INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
    VALUES (v_staff, 'support.revoked', 'tenant', v_tenant::text, jsonb_build_object('grant', p_grant));
  END IF;
END $$;

CREATE FUNCTION platform_set_feature_flag(p_token text, p_tenant uuid, p_key text, p_enabled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner');
BEGIN
  INSERT INTO tenant_feature_flags (tenant_id, key, enabled, set_by) VALUES (p_tenant, p_key, p_enabled, v_staff)
  ON CONFLICT (tenant_id, key) DO UPDATE SET enabled = EXCLUDED.enabled, set_by = EXCLUDED.set_by, set_at = now();
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'feature_flag.set', 'tenant', p_tenant::text, jsonb_build_object('key', p_key, 'enabled', p_enabled));
END $$;

CREATE FUNCTION platform_publish_plan_version(p_token text, p_version uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner');
BEGIN
  UPDATE plan_versions SET published_at = now() WHERE id = p_version AND published_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan version not found or already published' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id)
  VALUES (v_staff, 'plan.published', 'plan_version', p_version::text);
END $$;

-- Support views: only with an approved, unexpired grant for THIS staff member and company.
-- The view itself is written into the company's audit trail; nothing else can be written there.
CREATE FUNCTION platform_support_view(p_token text, p_tenant uuid, p_what text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token); v_rows jsonb;
BEGIN
  IF p_what NOT IN ('files', 'members') THEN RAISE EXCEPTION 'unknown view' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF NOT support_grant_active(p_tenant, v_staff) THEN
    RAISE EXCEPTION 'no active, approved support access for this company' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, metadata, hash)
  VALUES (p_tenant, v_staff, 'support.viewed', p_what, '{}'::jsonb, ''::bytea);
  IF p_what = 'files' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.original_name, 'contentType', f.content_type,
             'sizeBytes', f.size_bytes, 'status', f.status, 'createdAt', f.created_at) ORDER BY f.created_at DESC), '[]'::jsonb)
      INTO v_rows FROM files f WHERE f.tenant_id = p_tenant;
  ELSE
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'fullName', u.full_name, 'email', u.email, 'status', m.status)
             ORDER BY u.full_name), '[]'::jsonb)
      INTO v_rows FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = p_tenant;
  END IF;
  RETURN v_rows;
END $$;
GRANT SELECT ON users TO cf_ops;
CREATE POLICY ops_users_read ON users FOR SELECT TO cf_ops USING (true);

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'platform_session_staff(text)', 'platform_require(text,text)', 'platform_tenant_directory(text)',
    'platform_request_support(text,uuid,text,int)', 'platform_approve_support(text,uuid)', 'platform_revoke_support(text,uuid)',
    'platform_set_feature_flag(text,uuid,text,boolean)', 'platform_publish_plan_version(text,uuid)',
    'platform_support_view(text,uuid,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO cf_ops', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION platform_session_staff(text), platform_tenant_directory(text),
  platform_request_support(text, uuid, text, int), platform_approve_support(text, uuid), platform_revoke_support(text, uuid),
  platform_set_feature_flag(text, uuid, text, boolean), platform_publish_plan_version(text, uuid),
  platform_support_view(text, uuid, text) TO cf_platform;

-- 3. The platform role loses every direct path to company data ----------------------------------------
DROP POLICY platform_files ON files;
DROP POLICY platform_memberships ON memberships;
DROP POLICY platform_users ON users;
DROP POLICY platform_audit_read ON audit_events;
DROP POLICY platform_audit_write ON audit_events;
DROP POLICY platform_audit_self ON platform_audit_events;
REVOKE ALL ON files, memberships, users, audit_events, platform_audit_events FROM cf_platform;
REVOKE EXECUTE ON FUNCTION support_grant_active(uuid, uuid), platform_staff_role(uuid) FROM cf_platform;

-- 4. Sessions are created only by a function that fixes their lifetime and MFA state ------------------
REVOKE INSERT ON sessions FROM cf_identity;
CREATE FUNCTION auth_open_session(p_user_id uuid, p_token_hash bytea, p_active_tenant uuid, p_ip inet, p_user_agent text, p_hours int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 12 THEN
    RAISE EXCEPTION 'session lifetime must be 1 to 12 hours' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO sessions (token_hash, user_id, active_tenant_id, ip, user_agent, expires_at, mfa_verified_at)
  VALUES (p_token_hash, p_user_id, p_active_tenant, p_ip, left(p_user_agent, 400), now() + make_interval(hours => p_hours), NULL)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
ALTER FUNCTION auth_open_session(uuid, bytea, uuid, inet, text, int) OWNER TO cf_auth;
REVOKE ALL ON FUNCTION auth_open_session(uuid, bytea, uuid, inet, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_open_session(uuid, bytea, uuid, inet, text, int) TO cf_identity;

-- 5. Idle timeout cannot be skipped with NULL ----------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_session_lookup(p_token_hash bytea, p_idle interval)
RETURNS TABLE (session_id uuid, user_id uuid, active_tenant_id uuid, mfa_verified_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_idle IS NULL OR p_idle < interval '5 minutes' OR p_idle > interval '24 hours' THEN
    RAISE EXCEPTION 'idle timeout out of range' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE sessions SET revoked_at = now(), revoke_reason = 'idle'
  WHERE token_hash = p_token_hash AND revoked_at IS NULL AND last_seen_at < now() - p_idle;
  RETURN QUERY
  UPDATE sessions s SET last_seen_at = now()
  FROM users u
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
    AND s.created_at > now() - interval '12 hours'   -- absolute cap enforced by the database too
    AND u.id = s.user_id AND u.status = 'active'
  RETURNING s.id, s.user_id, s.active_tenant_id, s.mfa_verified_at, s.expires_at;
END $$;

-- 6. Email tokens have fixed maximum lifetimes; the notifier gets the STORED address -----------------------
CREATE OR REPLACE FUNCTION auth_issue_token(p_user_id uuid, p_purpose text, p_token_hash bytea, p_ttl interval)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_ttl IS NULL OR p_ttl <= interval '0'
     OR (p_purpose = 'verify_email' AND p_ttl > interval '24 hours')
     OR (p_purpose = 'reset_password' AND p_ttl > interval '1 hour') THEN
    RAISE EXCEPTION 'token lifetime not allowed for %', p_purpose USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE auth_tokens SET used_at = now() WHERE user_id = p_user_id AND purpose = p_purpose AND used_at IS NULL;
  INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (p_user_id, p_purpose, p_token_hash, now() + p_ttl);
END $$;

CREATE FUNCTION auth_user_for_email(p_email citext, OUT user_id uuid, OUT email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, email::text FROM users WHERE email = p_email AND status = 'active'
$$;
ALTER FUNCTION auth_user_for_email(citext) OWNER TO cf_auth;
REVOKE ALL ON FUNCTION auth_user_for_email(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_for_email(citext) TO cf_notify;
REVOKE EXECUTE ON FUNCTION auth_user_id_by_email(citext) FROM cf_notify;

-- 7. Subscriptions: the business API can create one (trial, by policy) but never change billing state -----
REVOKE UPDATE ON subscriptions FROM cf_app;
CREATE FUNCTION subscription_new_is_trial() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_days int;
BEGIN
  -- session_user: the role that logged in. (current_user would be the function owner inside SECURITY DEFINER.)
  IF session_user = 'cf_app' THEN
    SELECT trial_days INTO v_days FROM trial_policy;
    NEW.status := 'trialing';
    NEW.extra_seats := 0;
    NEW.billing_interval := 'month';
    NEW.trial_ends_at := now() + make_interval(days => v_days);
    NEW.current_period_start := now();
    NEW.current_period_end := NEW.trial_ends_at;
    NEW.payment_provider := NULL;
    NEW.payment_provider_ref := NULL;
  END IF;
  RETURN NEW;
END $$;
-- The trigger function runs as its owner (the migration owner), which can read trial_policy.
CREATE TRIGGER subscriptions_new_is_trial BEFORE INSERT ON subscriptions FOR EACH ROW EXECUTE FUNCTION subscription_new_is_trial();
-- A company has exactly one subscription; the API may create it only once (no deleting and re-inserting a better one).
REVOKE DELETE ON subscriptions FROM cf_app;
-- Operations (owner role) may remove or change a subscription, e.g. closing a company.
CREATE POLICY subscriptions_owner_all ON subscriptions FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
