-- 0008 Company settings, branches, teams (M1.4b) and the platform owner console with time-limited,
-- two-person-approved support access (M1.6b).
--
-- Platform staff use a separate database role, cf_platform. It sees company METADATA through narrow functions
-- (names, plan, status, counts). It can read a company's CONTENT only while an approved, unexpired support grant
-- exists for that staff member and that company — enforced by row-level security, not application code —
-- and every such read is written into that company's own audit trail.

-- 1. Company settings (FR-006) -------------------------------------------------------------------
CREATE TABLE tenant_settings (
  tenant_id                  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  business_hours             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"mon":[["09:00","18:00"]], ...}
  languages                  text[] NOT NULL DEFAULT '{en}' CHECK (languages <@ ARRAY['en', 'ar']::text[] AND cardinality(languages) >= 1),
  sla_first_response_minutes int CHECK (sla_first_response_minutes BETWEEN 1 AND 10080),
  sla_resolution_minutes     int CHECK (sla_resolution_minutes BETWEEN 1 AND 43200),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenant_holidays (
  id        uuid NOT NULL DEFAULT uuid_generate_v7() PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day       date NOT NULL,
  name      text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  UNIQUE (tenant_id, day),
  UNIQUE (tenant_id, id)
);

-- 2. Branches and teams ---------------------------------------------------------------------------
CREATE TABLE branches (
  id         uuid NOT NULL DEFAULT uuid_generate_v7() PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  timezone   text,
  address    text CHECK (length(address) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);
CREATE TABLE teams (
  id         uuid NOT NULL DEFAULT uuid_generate_v7() PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  branch_id  uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE SET NULL (branch_id)
);
CREATE TABLE team_members (
  tenant_id     uuid NOT NULL,
  team_id       uuid NOT NULL,
  membership_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, team_id, membership_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE
);

-- 3. Feature flags (platform-wide default, per-company override) ----------------------------------
CREATE TABLE feature_flags (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  description text NOT NULL,
  default_on  boolean NOT NULL DEFAULT false
);
CREATE TABLE tenant_feature_flags (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key       text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  enabled   boolean NOT NULL,
  set_by    uuid,
  set_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
INSERT INTO feature_flags (key, description, default_on) VALUES
  ('whatsapp_channel', 'WhatsApp channel (Phase 2)', false),
  ('ai_agents', 'AI agents (Phase 4)', false),
  ('arabic_ui', 'Arabic interface', true);

-- 4. Platform staff, support grants, platform audit -----------------------------------------------
CREATE TABLE platform_staff (
  user_id  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role     text NOT NULL CHECK (role IN ('platform_owner', 'support_agent')),
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by text NOT NULL            -- staff are added by the owner role only (operations runbook)
);

CREATE TABLE support_access_grants (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 20 AND 1000),
  requested_at timestamptz NOT NULL DEFAULT now(),
  duration     interval NOT NULL CHECK (duration > interval '0' AND duration <= interval '4 hours'),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> requested_by),          -- two people, always
  CHECK ((approved_at IS NULL) = (expires_at IS NULL)),
  CHECK (expires_at IS NULL OR expires_at <= approved_at + interval '4 hours')
);
CREATE INDEX ON support_access_grants (tenant_id, requested_by);

CREATE TABLE platform_audit_events (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  actor_user_id uuid NOT NULL,
  action        text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_.]+$'),
  target_type   text,
  target_id     text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER platform_audit_no_change BEFORE UPDATE OR DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- 5. Row-level security for the new company tables (cf_app) ---------------------------------------
ALTER TABLE tenant_settings      ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_settings      FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_holidays      ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_holidays      FORCE ROW LEVEL SECURITY;
ALTER TABLE branches             ENABLE ROW LEVEL SECURITY; ALTER TABLE branches             FORCE ROW LEVEL SECURITY;
ALTER TABLE teams                ENABLE ROW LEVEL SECURITY; ALTER TABLE teams                FORCE ROW LEVEL SECURITY;
ALTER TABLE team_members         ENABLE ROW LEVEL SECURITY; ALTER TABLE team_members         FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_flags ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_feature_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE support_access_grants ENABLE ROW LEVEL SECURITY; ALTER TABLE support_access_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_staff       ENABLE ROW LEVEL SECURITY; ALTER TABLE platform_staff       FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_events ENABLE ROW LEVEL SECURITY; ALTER TABLE platform_audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY settings_tenant ON tenant_settings FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY holidays_tenant ON tenant_holidays FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY branches_tenant ON branches FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY teams_tenant ON teams FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY team_members_tenant ON team_members FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY flags_tenant_read ON tenant_feature_flags FOR SELECT TO cf_app USING (tenant_id = app_tenant_id());
-- A company can see the support grants that concern it (transparency notice).
CREATE POLICY grants_tenant_read ON support_access_grants FOR SELECT TO cf_app USING (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_settings, tenant_holidays, branches, teams TO cf_app;
GRANT SELECT, INSERT, DELETE ON team_members TO cf_app;
GRANT SELECT ON tenant_feature_flags, feature_flags, support_access_grants TO cf_app;

-- 6. Platform role -------------------------------------------------------------------------------
-- cf_platform (LOGIN, created by the migration runner) and cf_ops (NOLOGIN owner of the platform functions).
GRANT USAGE ON SCHEMA public TO cf_platform, cf_ops;
GRANT CREATE ON SCHEMA public TO cf_ops;
GRANT EXECUTE ON FUNCTION uuid_generate_v7(), app_tenant_id(), app_user_id() TO cf_platform, cf_ops;

-- Is there an approved, unexpired, unrevoked grant for this staff member in this company?
CREATE FUNCTION support_grant_active(p_tenant uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM support_access_grants g JOIN platform_staff s ON s.user_id = g.requested_by
    WHERE g.tenant_id = p_tenant AND g.requested_by = p_user AND g.approved_at IS NOT NULL
      AND g.revoked_at IS NULL AND g.expires_at > now())
$$;

CREATE FUNCTION platform_staff_role(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT role FROM platform_staff WHERE user_id = p_user
$$;

-- Company directory: metadata only — never message, file or contact content.
CREATE FUNCTION platform_tenant_directory()
RETURNS TABLE (tenant_id uuid, slug text, legal_name text, country text, status text, data_region text, created_at timestamptz,
               plan_code text, plan_version int, subscription_status text, trial_ends_at timestamptz,
               active_members int, files_count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.slug::text, t.legal_name, t.country::text, t.status, t.data_region, t.created_at,
         p.code, v.version, s.status, s.trial_ends_at,
         (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active'),
         (SELECT count(*)::int FROM files f WHERE f.tenant_id = t.id)
  FROM tenants t
  LEFT JOIN subscriptions s ON s.tenant_id = t.id
  LEFT JOIN plan_versions v ON v.id = s.plan_version_id
  LEFT JOIN plans p ON p.id = v.plan_id
  ORDER BY t.created_at DESC
$$;

-- Request, approve, revoke support access (two-person rule, max 4 hours).
CREATE FUNCTION platform_request_support(p_tenant uuid, p_reason text, p_minutes int) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF platform_staff_role(app_user_id()) IS NULL THEN RAISE EXCEPTION 'not platform staff' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO support_access_grants (tenant_id, requested_by, reason, duration)
  VALUES (p_tenant, app_user_id(), p_reason, make_interval(mins => p_minutes)) RETURNING id INTO v_id;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (app_user_id(), 'support.requested', 'tenant', p_tenant::text, jsonb_build_object('grant', v_id, 'minutes', p_minutes, 'reason', p_reason));
  RETURN v_id;
END $$;

CREATE FUNCTION platform_approve_support(p_grant uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_exp timestamptz; v_tenant uuid;
BEGIN
  IF platform_staff_role(app_user_id()) IS DISTINCT FROM 'platform_owner' THEN
    RAISE EXCEPTION 'only a platform owner can approve support access' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE support_access_grants SET approved_by = app_user_id(), approved_at = now(), expires_at = now() + duration
  WHERE id = p_grant AND approved_at IS NULL AND revoked_at IS NULL AND requested_by <> app_user_id()
    AND requested_at > now() - interval '24 hours'
  RETURNING expires_at, tenant_id INTO v_exp, v_tenant;
  IF v_exp IS NULL THEN RAISE EXCEPTION 'grant cannot be approved (missing, already decided, stale, or your own request)' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (app_user_id(), 'support.approved', 'tenant', v_tenant::text, jsonb_build_object('grant', p_grant, 'expires_at', v_exp));
  -- The company is told, in its own audit trail.
  INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, metadata, hash)
  VALUES (v_tenant, NULL, 'support.access_granted', 'support_grant', p_grant::text, jsonb_build_object('expires_at', v_exp), ''::bytea);
  RETURN v_exp;
END $$;

CREATE FUNCTION platform_revoke_support(p_grant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid;
BEGIN
  IF platform_staff_role(app_user_id()) IS NULL THEN RAISE EXCEPTION 'not platform staff' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE support_access_grants SET revoked_at = now() WHERE id = p_grant AND revoked_at IS NULL RETURNING tenant_id INTO v_tenant;
  IF v_tenant IS NOT NULL THEN
    INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
    VALUES (app_user_id(), 'support.revoked', 'tenant', v_tenant::text, jsonb_build_object('grant', p_grant));
  END IF;
END $$;

CREATE FUNCTION platform_set_feature_flag(p_tenant uuid, p_key text, p_enabled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF platform_staff_role(app_user_id()) IS DISTINCT FROM 'platform_owner' THEN
    RAISE EXCEPTION 'only a platform owner can change feature flags' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO tenant_feature_flags (tenant_id, key, enabled, set_by) VALUES (p_tenant, p_key, p_enabled, app_user_id())
  ON CONFLICT (tenant_id, key) DO UPDATE SET enabled = EXCLUDED.enabled, set_by = EXCLUDED.set_by, set_at = now();
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (app_user_id(), 'feature_flag.set', 'tenant', p_tenant::text, jsonb_build_object('key', p_key, 'enabled', p_enabled));
END $$;

CREATE FUNCTION platform_publish_plan_version(p_version uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF platform_staff_role(app_user_id()) IS DISTINCT FROM 'platform_owner' THEN
    RAISE EXCEPTION 'only a platform owner can publish prices' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Drafts have no subscribers, so the freeze trigger allows marking them published.
  UPDATE plan_versions SET published_at = now() WHERE id = p_version AND published_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan version not found or already published' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id)
  VALUES (app_user_id(), 'plan.published', 'plan_version', p_version::text);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'support_grant_active(uuid,uuid)', 'platform_staff_role(uuid)', 'platform_tenant_directory()',
    'platform_request_support(uuid,text,int)', 'platform_approve_support(uuid)', 'platform_revoke_support(uuid)',
    'platform_set_feature_flag(uuid,text,boolean)', 'platform_publish_plan_version(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO cf_ops', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO cf_platform', f);
  END LOOP;
END $$;
-- support_grant_active is also used inside the cf_platform content policies below.
GRANT EXECUTE ON FUNCTION support_grant_active(uuid, uuid) TO cf_platform;

-- What cf_ops (function owner) may touch.
GRANT SELECT ON tenants, subscriptions, plan_versions, plans, memberships, files, platform_staff TO cf_ops;
GRANT SELECT, INSERT, UPDATE ON support_access_grants TO cf_ops;
GRANT INSERT ON platform_audit_events, audit_events TO cf_ops;
GRANT SELECT ON audit_events TO cf_ops;  -- the audit hash chain trigger reads the previous row
GRANT SELECT, INSERT, UPDATE ON tenant_feature_flags TO cf_ops;
GRANT UPDATE (published_at) ON plan_versions TO cf_ops;
CREATE POLICY ops_tenants       ON tenants               FOR SELECT TO cf_ops USING (true);
CREATE POLICY ops_subscriptions ON subscriptions         FOR SELECT TO cf_ops USING (true);
CREATE POLICY ops_memberships   ON memberships           FOR SELECT TO cf_ops USING (true);
CREATE POLICY ops_files         ON files                 FOR SELECT TO cf_ops USING (true);
CREATE POLICY ops_staff         ON platform_staff        FOR SELECT TO cf_ops USING (true);
-- Staff are added and removed by the owner role only (operations runbook), never through the API.
CREATE POLICY staff_owner       ON platform_staff        FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY ops_grants        ON support_access_grants FOR ALL TO cf_ops USING (true) WITH CHECK (true);
CREATE POLICY ops_platform_audit ON platform_audit_events FOR INSERT TO cf_ops WITH CHECK (true);
CREATE POLICY ops_audit         ON audit_events          FOR ALL TO cf_ops USING (true) WITH CHECK (true);
CREATE POLICY ops_flags         ON tenant_feature_flags  FOR ALL TO cf_ops USING (true) WITH CHECK (true);

-- cf_platform: content of ONE company, only while its grant is active, read-only.
GRANT SELECT ON files, memberships, users, audit_events, plans, plan_versions, feature_flags TO cf_platform;
GRANT SELECT ON platform_audit_events TO cf_platform;
GRANT INSERT ON audit_events TO cf_platform;
CREATE POLICY platform_files ON files FOR SELECT TO cf_platform
  USING (tenant_id = app_tenant_id() AND support_grant_active(tenant_id, app_user_id()));
CREATE POLICY platform_memberships ON memberships FOR SELECT TO cf_platform
  USING (tenant_id = app_tenant_id() AND support_grant_active(tenant_id, app_user_id()));
CREATE POLICY platform_users ON users FOR SELECT TO cf_platform
  USING (id = app_user_id() OR id IN (SELECT m.user_id FROM memberships m WHERE m.tenant_id = app_tenant_id()));
CREATE POLICY platform_audit_read ON audit_events FOR SELECT TO cf_platform
  USING (tenant_id = app_tenant_id() AND support_grant_active(tenant_id, app_user_id()));
-- Each support read is written into the company's own audit trail.
CREATE POLICY platform_audit_write ON audit_events FOR INSERT TO cf_platform
  WITH CHECK (tenant_id = app_tenant_id() AND support_grant_active(tenant_id, app_user_id()) AND actor_user_id = app_user_id());
CREATE POLICY platform_audit_self ON platform_audit_events FOR SELECT TO cf_platform USING (true);
