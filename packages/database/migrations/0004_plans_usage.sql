-- 0004 Plans, entitlements, subscriptions and usage limits.
-- Prices and limits are data, never code. A plan version that a subscription uses can no longer be edited:
-- changing a price means publishing a new version.

CREATE TABLE plans (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  code       text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name       text NOT NULL,
  is_public  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_versions (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  plan_id             uuid NOT NULL REFERENCES plans(id),
  version             int  NOT NULL CHECK (version > 0),
  currency            char(3) NOT NULL DEFAULT 'USD',
  price_monthly_cents int CHECK (price_monthly_cents >= 0),
  price_annual_cents  int CHECK (price_annual_cents >= 0),
  trial_days          int NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 90),
  effective_from      timestamptz NOT NULL DEFAULT now(),
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

-- limit_value NULL means "no limit configured" and is only allowed where the plan is contract-based.
CREATE TABLE plan_entitlements (
  plan_version_id     uuid NOT NULL REFERENCES plan_versions(id),
  key                 text NOT NULL CHECK (key IN ('seats', 'whatsapp_numbers', 'automation_executions', 'ai_credits', 'outbound_messages')),
  limit_value         bigint CHECK (limit_value >= 0),
  addon_price_cents   int CHECK (addon_price_cents >= 0),   -- e.g. price of one extra seat; NULL = not sold as add-on
  PRIMARY KEY (plan_version_id, key)
);

CREATE TABLE subscriptions (
  id                   uuid NOT NULL DEFAULT uuid_generate_v7() PRIMARY KEY,
  tenant_id            uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_version_id      uuid NOT NULL REFERENCES plan_versions(id),
  status               text NOT NULL DEFAULT 'trialing'
                       CHECK (status IN ('trialing', 'active', 'past_due', 'suspended', 'cancelled')),
  billing_interval     text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year')),
  extra_seats          int  NOT NULL DEFAULT 0 CHECK (extra_seats >= 0),
  trial_ends_at        timestamptz,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end   timestamptz,
  payment_provider     text,      -- stays NULL until live payments are approved (Phase 5)
  payment_provider_ref text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE entitlement_overrides (
  id          uuid NOT NULL DEFAULT uuid_generate_v7() PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  limit_value bigint NOT NULL CHECK (limit_value >= 0),
  reason      text NOT NULL,
  granted_by  uuid,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON entitlement_overrides (tenant_id, key);

CREATE TABLE usage_counters (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key          text NOT NULL,
  period_start date NOT NULL,
  used         bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  warned_80_at timestamptz,
  warned_95_at timestamptz,
  PRIMARY KEY (tenant_id, key, period_start)
);

-- Plan versions in use are frozen. (SECURITY DEFINER so the check sees every company's subscriptions.)
CREATE FUNCTION plan_version_frozen() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM subscriptions WHERE plan_version_id = OLD.id) THEN
    RAISE EXCEPTION 'plan version % is in use; publish a new version instead', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE FUNCTION plan_entitlement_frozen() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM subscriptions WHERE plan_version_id = OLD.plan_version_id) THEN
    RAISE EXCEPTION 'plan version % is in use; publish a new version instead', OLD.plan_version_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER plan_versions_frozen BEFORE UPDATE OR DELETE ON plan_versions FOR EACH ROW EXECUTE FUNCTION plan_version_frozen();
CREATE TRIGGER plan_entitlements_frozen BEFORE UPDATE OR DELETE ON plan_entitlements FOR EACH ROW EXECUTE FUNCTION plan_entitlement_frozen();

ALTER TABLE subscriptions         ENABLE ROW LEVEL SECURITY; ALTER TABLE subscriptions         FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlement_overrides ENABLE ROW LEVEL SECURITY; ALTER TABLE entitlement_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_counters        ENABLE ROW LEVEL SECURITY; ALTER TABLE usage_counters        FORCE ROW LEVEL SECURITY;

CREATE POLICY subscriptions_tenant ON subscriptions FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY overrides_tenant_read ON entitlement_overrides FOR SELECT TO cf_app USING (tenant_id = app_tenant_id());
CREATE POLICY usage_tenant ON usage_counters FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- The owner role (platform operations) works through the same tenant context.
CREATE POLICY overrides_owner ON entitlement_overrides FOR ALL TO CURRENT_USER
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- The freeze trigger runs as the owner and must see every subscription to know whether a version is in use.
CREATE POLICY subscriptions_owner_read ON subscriptions FOR SELECT TO CURRENT_USER USING (true);

GRANT SELECT ON plans, plan_versions, plan_entitlements TO cf_app;
GRANT SELECT, INSERT, UPDATE ON subscriptions, usage_counters TO cf_app;
GRANT SELECT ON entitlement_overrides TO cf_app;

-- Proposed launch catalogue from BRD v1.1, section 4. Proposed prices only: editable as new versions.
-- Annual prices are not set in the BRD and stay NULL until approved.
WITH p AS (
  INSERT INTO plans (code, name) VALUES ('starter', 'Starter'), ('growth', 'Growth'), ('business', 'Business'), ('enterprise', 'Enterprise')
  RETURNING id, code
), v AS (
  INSERT INTO plan_versions (plan_id, version, price_monthly_cents, note)
  SELECT id, 1, CASE code WHEN 'starter' THEN 2900 WHEN 'growth' THEN 7900 WHEN 'business' THEN 19900 ELSE 49900 END,
         'BRD v1.1 proposed price; subject to validation'
  FROM p RETURNING id, plan_id
)
INSERT INTO plan_entitlements (plan_version_id, key, limit_value, addon_price_cents)
SELECT v.id, e.key, e.limit_value, e.addon
FROM v JOIN p ON p.id = v.plan_id
JOIN (VALUES
  ('starter',    'seats', 3, NULL),     ('starter',    'whatsapp_numbers', 1, NULL),  ('starter',    'automation_executions', 1000, NULL),
  ('growth',     'seats', 10, 800),     ('growth',     'whatsapp_numbers', 2, NULL),  ('growth',     'automation_executions', 5000, NULL),
  ('business',   'seats', 25, 700),     ('business',   'whatsapp_numbers', 5, NULL),  ('business',   'automation_executions', 25000, NULL),
  ('enterprise', 'seats', 50, NULL),    ('enterprise', 'whatsapp_numbers', 10, NULL), ('enterprise', 'automation_executions', NULL, NULL)
) AS e(code, key, limit_value, addon) ON e.code = p.code;
