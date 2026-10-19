-- 0013 Pilot enrolment: narrower rights for cf_ops, and re-enrolment after a pilot ends
-- (targeted independent review of ee77e77, informational notes). Behaviour of the console actions is unchanged.

-- 1. A company may have several pilot records over time, but only one running pilot.
ALTER TABLE pilot_enrolments DROP CONSTRAINT pilot_enrolments_pkey;
ALTER TABLE pilot_enrolments ADD COLUMN id uuid NOT NULL DEFAULT uuid_generate_v7();
ALTER TABLE pilot_enrolments ADD PRIMARY KEY (id);
CREATE UNIQUE INDEX pilot_enrolments_one_running ON pilot_enrolments (tenant_id) WHERE ended_at IS NULL;

-- 2. cf_ops gets exactly what the two functions use.
DROP POLICY pilot_ops ON pilot_enrolments;
REVOKE ALL ON pilot_enrolments FROM cf_ops;
CREATE POLICY pilot_ops_read   ON pilot_enrolments FOR SELECT TO cf_ops USING (true);
CREATE POLICY pilot_ops_insert ON pilot_enrolments FOR INSERT TO cf_ops WITH CHECK (true);
CREATE POLICY pilot_ops_end    ON pilot_enrolments FOR UPDATE TO cf_ops USING (ended_at IS NULL) WITH CHECK (ended_at IS NOT NULL);
GRANT SELECT (id, tenant_id, ended_at, seat_override_id) ON pilot_enrolments TO cf_ops;
GRANT INSERT (tenant_id, seat_allowance, reason, ends_at, seat_override_id, enrolled_by) ON pilot_enrolments TO cf_ops;
GRANT UPDATE (ended_at) ON pilot_enrolments TO cf_ops;

DROP POLICY overrides_ops ON entitlement_overrides;
REVOKE ALL ON entitlement_overrides FROM cf_ops;
CREATE POLICY overrides_ops_read   ON entitlement_overrides FOR SELECT TO cf_ops USING (key = 'seats');
CREATE POLICY overrides_ops_insert ON entitlement_overrides FOR INSERT TO cf_ops WITH CHECK (key = 'seats' AND expires_at IS NOT NULL);
CREATE POLICY overrides_ops_expire ON entitlement_overrides FOR UPDATE TO cf_ops USING (key = 'seats') WITH CHECK (key = 'seats');
GRANT SELECT (id, expires_at, key) ON entitlement_overrides TO cf_ops;
GRANT INSERT (tenant_id, key, limit_value, reason, granted_by, expires_at) ON entitlement_overrides TO cf_ops;
GRANT UPDATE (expires_at) ON entitlement_overrides TO cf_ops;

-- 3. Enrolment checks for a RUNNING pilot instead of any earlier record.
CREATE OR REPLACE FUNCTION platform_enrol_pilot(p_token text, p_tenant uuid, p_seats int, p_days int, p_reason text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_ends timestamptz; v_override uuid;
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
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'pilot.enrolled', 'tenant', p_tenant::text,
          jsonb_build_object('seats', p_seats, 'days', p_days, 'requiresMfa', true, 'endsAt', v_ends));
  RETURN v_ends;
END $$;
