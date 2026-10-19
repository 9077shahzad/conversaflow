-- 0011 Pilot enrolment (owner decisions, 20 Oct 2026)
-- 1. Every user of a pilot company must use two-step sign-in. Enforced by the API on every company request.
-- 2. A pilot company gets its own seat allowance (default 10), recorded as an expiring override.
--    The standard trial caps (trial_caps) are not touched.
-- Only a platform owner, through a token-bound console action, can enrol or end a pilot. Companies can read
-- their own enrolment but cannot change it.

CREATE TABLE pilot_enrolments (
  tenant_id         uuid NOT NULL PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  seat_allowance    int  NOT NULL CHECK (seat_allowance BETWEEN 1 AND 50),
  requires_mfa      boolean NOT NULL DEFAULT true CHECK (requires_mfa), -- pilot policy: always on
  reason            text NOT NULL CHECK (length(trim(reason)) >= 10),
  starts_at         timestamptz NOT NULL DEFAULT now(),
  ends_at           timestamptz NOT NULL,
  ended_at          timestamptz,
  seat_override_id  uuid NOT NULL REFERENCES entitlement_overrides(id),
  enrolled_by       uuid NOT NULL REFERENCES users(id),
  CHECK (ends_at > starts_at)
);
ALTER TABLE pilot_enrolments ENABLE ROW LEVEL SECURITY; ALTER TABLE pilot_enrolments FORCE ROW LEVEL SECURITY;
CREATE POLICY pilot_tenant_read ON pilot_enrolments FOR SELECT TO cf_app USING (tenant_id = app_tenant_id());
CREATE POLICY pilot_ops ON pilot_enrolments FOR ALL TO cf_ops USING (true) WITH CHECK (true);
GRANT SELECT ON pilot_enrolments TO cf_app;
GRANT SELECT, INSERT, UPDATE ON pilot_enrolments TO cf_ops;

-- The console functions write the seat allowance as an ordinary, expiring override.
CREATE POLICY overrides_ops ON entitlement_overrides FOR ALL TO cf_ops USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE (expires_at) ON entitlement_overrides TO cf_ops;
GRANT SELECT (id) ON tenants TO cf_ops;

-- Is two-step sign-in mandatory for this company right now? Read by the API inside the company's context.
CREATE FUNCTION tenant_requires_mfa() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM pilot_enrolments p
                 WHERE p.tenant_id = app_tenant_id() AND p.requires_mfa
                   AND p.ended_at IS NULL AND p.starts_at <= now() AND p.ends_at > now());
$$;
GRANT EXECUTE ON FUNCTION tenant_requires_mfa() TO cf_app;

CREATE FUNCTION platform_enrol_pilot(p_token text, p_tenant uuid, p_seats int, p_days int, p_reason text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_ends timestamptz; v_override uuid;
BEGIN
  IF p_days IS NULL OR p_days NOT BETWEEN 7 AND 180 THEN
    RAISE EXCEPTION 'pilot length must be 7 to 180 days' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) THEN
    RAISE EXCEPTION 'company not found' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM pilot_enrolments WHERE tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'this company already has a pilot record' USING ERRCODE = 'check_violation';
  END IF;
  v_ends := now() + make_interval(days => p_days);
  INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason, granted_by, expires_at)
  VALUES (p_tenant, 'seats', p_seats, 'Pilot seat allowance: ' || p_reason, v_staff, v_ends)
  RETURNING id INTO v_override;
  INSERT INTO pilot_enrolments (tenant_id, seat_allowance, reason, ends_at, seat_override_id, enrolled_by)
  VALUES (p_tenant, p_seats, p_reason, v_ends, v_override, v_staff);
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'pilot.enrolled', 'tenant', p_tenant::text,
          jsonb_build_object('seats', p_seats, 'days', p_days, 'requiresMfa', true, 'endsAt', v_ends));
  RETURN v_ends;
END $$;

CREATE FUNCTION platform_end_pilot(p_token text, p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_override uuid;
BEGIN
  UPDATE pilot_enrolments SET ended_at = now() WHERE tenant_id = p_tenant AND ended_at IS NULL
  RETURNING seat_override_id INTO v_override;
  IF v_override IS NULL THEN RAISE EXCEPTION 'no running pilot for this company' USING ERRCODE = 'check_violation'; END IF;
  UPDATE entitlement_overrides SET expires_at = now() WHERE id = v_override AND (expires_at IS NULL OR expires_at > now());
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id)
  VALUES (v_staff, 'pilot.ended', 'tenant', p_tenant::text);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['platform_enrol_pilot(text,uuid,int,int,text)', 'platform_end_pilot(text,uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO cf_ops', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION platform_enrol_pilot(text, uuid, int, int, text), platform_end_pilot(text, uuid) TO cf_platform;
REVOKE ALL ON FUNCTION tenant_requires_mfa() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_requires_mfa() TO cf_app;
