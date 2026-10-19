-- 0007 Commercial policies decided by the owner on 19 Oct 2026. All values are configuration, not code.
--   * Annual prices: draft at 10 x monthly, excluding Meta fees and usage overages; NOT published.
--   * Trial: 14 days, clear usage caps, no marketing messages; configurable.
--   * Retention: proposals by data type; automatic deletion stays OFF until a policy is approved.
--   * Automation usage: one completed workflow execution = one run; retries/resumes never count twice;
--     failed executions tracked separately and not billed.
--   * Meta rates: dated, configurable, only "verified" rates can be shown to customers.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. Plan versions can be drafts. Only published versions can be chosen or subscribed to. ----------
ALTER TABLE plan_versions ADD COLUMN published_at timestamptz;
-- The version 1 catalogue is the live (monthly) one. The freeze trigger is paused only for this one-time marking.
ALTER TABLE plan_versions DISABLE TRIGGER plan_versions_frozen;
UPDATE plan_versions SET published_at = created_at;
ALTER TABLE plan_versions ENABLE TRIGGER plan_versions_frozen;

CREATE FUNCTION subscription_requires_published_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plan_versions WHERE id = NEW.plan_version_id AND published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'plan version is a draft and cannot be subscribed to' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscriptions_published_version BEFORE INSERT OR UPDATE OF plan_version_id ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION subscription_requires_published_version();

-- Draft version 2 of each plan: same monthly price and limits, annual = 10 x monthly.
WITH v1 AS (
  SELECT v.* FROM plan_versions v WHERE v.version = 1
), v2 AS (
  INSERT INTO plan_versions (plan_id, version, currency, price_monthly_cents, price_annual_cents, trial_days, note, published_at)
  SELECT plan_id, 2, currency, price_monthly_cents, price_monthly_cents * 10, trial_days,
         'DRAFT for margin review: annual = 10 x monthly; excludes Meta fees and usage overages; publication pending owner approval',
         NULL
  FROM v1 RETURNING id, plan_id
)
INSERT INTO plan_entitlements (plan_version_id, key, limit_value, addon_price_cents)
SELECT v2.id, e.key, e.limit_value, e.addon_price_cents
FROM v2 JOIN v1 ON v1.plan_id = v2.plan_id JOIN plan_entitlements e ON e.plan_version_id = v1.id;

-- Platform operations (owner role) can change a subscription's status, e.g. end a trial. Live billing comes in Phase 5.
CREATE POLICY subscriptions_owner_update ON subscriptions FOR UPDATE TO CURRENT_USER USING (true) WITH CHECK (true);

-- 2. Trial policy (one row) and caps -------------------------------------------------------------
CREATE TABLE trial_policy (
  id                         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  trial_days                 int NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 90),
  marketing_messages_allowed boolean NOT NULL DEFAULT false,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  note                       text
);
INSERT INTO trial_policy (trial_days, marketing_messages_allowed, note)
VALUES (14, false, 'Owner decision 19 Oct 2026: 14 days, usage caps, no marketing messages');

CREATE TABLE trial_caps (
  key         text PRIMARY KEY CHECK (key IN ('seats', 'whatsapp_numbers', 'automation_executions', 'ai_credits', 'outbound_messages')),
  limit_value bigint NOT NULL CHECK (limit_value >= 0)
);
-- Proposed caps, editable. A trial gets the LOWER of its plan limit and these caps.
INSERT INTO trial_caps (key, limit_value) VALUES
  ('seats', 3), ('whatsapp_numbers', 1), ('automation_executions', 200), ('ai_credits', 100), ('outbound_messages', 250);

-- 3. Retention by data type: proposals only; automatic deletion cannot be switched on without approval --
CREATE TABLE retention_policies (
  data_type           text PRIMARY KEY CHECK (data_type ~ '^[a-z_]+$'),
  retain_days         int NOT NULL CHECK (retain_days > 0),
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved')),
  auto_delete_enabled boolean NOT NULL DEFAULT false,
  approved_at         timestamptz,
  approved_by         text,
  note                text,
  CHECK (status = 'proposed' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)),
  CHECK (NOT auto_delete_enabled OR status = 'approved')
);
INSERT INTO retention_policies (data_type, retain_days, note) VALUES
  ('messages', 730, 'Proposal: 24 months'),
  ('message_media', 730, 'Proposal: 24 months'),
  ('files', 730, 'Proposal: 24 months'),
  ('audit_events', 2557, 'Proposal: 7 years');

-- 4. Usage events: one row per counted thing, keyed so retries and resumes cannot count twice ------
CREATE TABLE usage_events (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key           text NOT NULL CHECK (key IN ('automation_run')),
  source_id     text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),  -- e.g. the workflow run id
  outcome       text NOT NULL CHECK (outcome IN ('completed', 'failed')),
  period_start  date NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key, source_id)
);
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY; ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_events_tenant ON usage_events FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON usage_events TO cf_app;

-- 5. Provider (Meta) rates: dated, configurable, verified before any customer sees them --------------
CREATE TABLE provider_rates (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  provider           text NOT NULL CHECK (provider IN ('meta_whatsapp')),
  market             text NOT NULL,          -- country code or Meta market name, as on Meta's rate card
  category           text NOT NULL CHECK (category IN ('marketing', 'utility', 'authentication',
                       'authentication_international', 'service', 'business_agent')),
  unit               text NOT NULL CHECK (unit IN ('message', 'million_tokens')),
  currency           char(3) NOT NULL,
  rate               numeric(14, 6) NOT NULL CHECK (rate >= 0),
  effective_from     date NOT NULL,
  effective_to       date,                   -- exclusive; NULL = until replaced
  source_url         text NOT NULL,
  source_checked_on  date NOT NULL,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified')),
  reconciliation_note text,                  -- how conflicting official sources were resolved
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (status = 'draft' OR reconciliation_note IS NOT NULL),
  -- Two verified rates for the same thing can never overlap in time.
  EXCLUDE USING gist (provider WITH =, market WITH =, category WITH =, currency WITH =,
    daterange(effective_from, effective_to) WITH &&) WHERE (status = 'verified')
);

CREATE TABLE provider_allowances (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  provider           text NOT NULL CHECK (provider IN ('meta_whatsapp')),
  category           text NOT NULL,
  free_units         int NOT NULL CHECK (free_units >= 0),
  per                text NOT NULL CHECK (per IN ('phone_number_month')),
  effective_from     date NOT NULL,
  effective_to       date,
  source_url         text NOT NULL,
  source_checked_on  date NOT NULL,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified')),
  reconciliation_note text,
  CHECK (status = 'draft' OR reconciliation_note IS NOT NULL)
);

-- Facts confirmed on Meta's pages on 19 Oct 2026. Country message rates are NOT loaded: they must be imported
-- from Meta's current rate card and reconciled first.
INSERT INTO provider_allowances (provider, category, free_units, per, effective_from, source_url, source_checked_on, status, reconciliation_note)
VALUES ('meta_whatsapp', 'service', 1000, 'phone_number_month', '2026-10-01',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing', '2026-10-19', 'draft',
  'Stated on the main pricing page; the non-template pricing page describes service charging from 1 Oct 2026 without restating the allowance. Reconcile before verifying.');
INSERT INTO provider_rates (provider, market, category, unit, currency, rate, effective_from, source_url, source_checked_on, status, reconciliation_note)
VALUES ('meta_whatsapp', 'global', 'business_agent', 'million_tokens', 'USD', 2.000000, '2026-08-01',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages/', '2026-10-19', 'verified',
  'Same rate (USD 2.00 per 1M tokens, one global rate) on both the pricing page and the non-template pricing page, checked 19 Oct 2026.');

GRANT SELECT ON trial_policy, trial_caps, retention_policies, provider_rates, provider_allowances TO cf_app;
