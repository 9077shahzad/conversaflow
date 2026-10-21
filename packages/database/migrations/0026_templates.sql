-- 0026 Message templates (BRD v1.2 Wave 1; CF-EXT-001, FR-107).
-- Outside the 24-hour customer service window only an approved template may be sent. Templates belong to the
-- WhatsApp Business Account (WABA), not to a phone number, and Meta reports their review, quality and category
-- changes by webhook with the WABA id as entry.id (Meta webhook reference message_template_status_update, read
-- 21 Oct 2026, page undated). So:
--  * provider_accounts records each company's business account; one account belongs to exactly one company;
--  * template webhooks are routed by account through one reviewed lookup owned by cf_channel;
--  * a template can be sent only while approved, and is checked again at send time;
--  * marketing templates need recorded marketing consent (BRD journey J5), and nothing is sent to an opted-out contact.

-- Business accounts ------------------------------------------------------------------------------------------------------
CREATE TABLE provider_accounts (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('sandbox', 'whatsapp_cloud')),
  -- Meta's WABA id. Unique across the platform: one business account can never be claimed by two companies.
  account_id  text NOT NULL CHECK (account_id ~ '^[0-9A-Za-z_-]{3,64}$'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, account_id),
  UNIQUE (tenant_id, id)
);
ALTER TABLE provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_accounts_tenant ON provider_accounts FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON provider_accounts TO cf_app;
GRANT UPDATE (status) ON provider_accounts TO cf_app;

-- Every connection belongs to an account. Existing connections each get their own account record, with a placeholder
-- account id ('acct-<number id>'): template webhooks for those accounts will not route until the real WABA id is set
-- by onboarding. Backfilled with FORCE row-level security switched off for this transaction only (the migration owner
-- is subject to it; review of slice 3, finding 1).
ALTER TABLE channel_connections ADD COLUMN account_ref uuid;
ALTER TABLE channel_connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_accounts NO FORCE ROW LEVEL SECURITY;
INSERT INTO provider_accounts (tenant_id, provider, account_id)
  SELECT tenant_id, provider, 'acct-' || provider_number_id FROM channel_connections;
UPDATE channel_connections c SET account_ref = a.id FROM provider_accounts a
  WHERE a.tenant_id = c.tenant_id AND a.provider = c.provider AND a.account_id = 'acct-' || c.provider_number_id;
ALTER TABLE channel_connections ALTER COLUMN account_ref SET NOT NULL;
-- Validating the new foreign key reads existing rows too, so it also runs before FORCE is switched back on.
ALTER TABLE channel_connections ADD CONSTRAINT channel_connections_account_fk
  FOREIGN KEY (tenant_id, account_ref) REFERENCES provider_accounts (tenant_id, id);
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_accounts FORCE ROW LEVEL SECURITY;
GRANT INSERT (account_ref) ON channel_connections TO cf_app;

-- Routing of account-level webhooks: cf_channel may read only these columns of active accounts.
GRANT SELECT (id, tenant_id, provider, account_id, status) ON provider_accounts TO cf_channel;
CREATE POLICY provider_accounts_route ON provider_accounts FOR SELECT TO cf_channel USING (status = 'active');
CREATE FUNCTION account_route(p_provider text, p_account text) RETURNS TABLE (tenant_id uuid, account_ref uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.tenant_id, a.id FROM provider_accounts a
  WHERE a.provider = p_provider AND a.account_id = p_account AND a.status = 'active'
$$;
ALTER FUNCTION account_route(text, text) OWNER TO cf_channel;
REVOKE ALL ON FUNCTION account_route(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION account_route(text, text) TO cf_app;

-- Webhook events may now belong to an account rather than a number (template updates).
ALTER TABLE webhook_events ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE webhook_events ADD COLUMN account_ref uuid;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_account_fk FOREIGN KEY (tenant_id, account_ref) REFERENCES provider_accounts (tenant_id, id);
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_routed CHECK ((connection_id IS NULL) <> (account_ref IS NULL));
CREATE UNIQUE INDEX webhook_events_account_key ON webhook_events (tenant_id, account_ref, event_key) WHERE account_ref IS NOT NULL;
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_kind_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_kind_check CHECK (kind IN ('message', 'status', 'template'));
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_outcome_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_outcome_check
  CHECK (outcome IN ('applied', 'stale_status', 'orphan_status', 'unknown_template'));
GRANT INSERT (account_ref) ON webhook_events TO cf_app;

-- Templates ------------------------------------------------------------------------------------------------------------------
CREATE TABLE message_templates (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id            uuid NOT NULL,
  account_ref          uuid NOT NULL,
  -- Meta: lowercase letters, digits and underscores.
  name                 text NOT NULL CHECK (name ~ '^[a-z0-9_]+$' AND length(name) <= 512),
  language             text NOT NULL CHECK (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  category             text NOT NULL CHECK (category IN ('marketing', 'utility', 'authentication')),
  -- Our view of Meta's review state. Only 'approved' may be sent.
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected', 'paused', 'disabled', 'in_appeal', 'archived', 'deleted')),
  -- Meta's last event name as received (e.g. FLAGGED, LIMIT_EXCEEDED, LOCKED), for display.
  last_event           text CHECK (last_event IS NULL OR length(last_event) <= 40),
  status_reason        text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  quality              text NOT NULL DEFAULT 'unknown' CHECK (quality IN ('unknown', 'green', 'yellow', 'red')),
  header_text          text CHECK (header_text IS NULL OR length(header_text) BETWEEN 1 AND 60),
  body_text            text NOT NULL CHECK (length(body_text) BETWEEN 1 AND 1024),
  footer_text          text CHECK (footer_text IS NULL OR length(footer_text) BETWEEN 1 AND 60),
  param_count          smallint NOT NULL CHECK (param_count BETWEEN 0 AND 20),
  examples             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(examples) = 'array'),
  provider_template_id text CHECK (provider_template_id IS NULL OR provider_template_id ~ '^[0-9A-Za-z_.-]{1,64}$'),
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  status_changed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account_ref, name, language),
  UNIQUE (tenant_id, provider_template_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_ref) REFERENCES provider_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, id)
);
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY message_templates_tenant ON message_templates FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON message_templates TO cf_app;
GRANT UPDATE (status, last_event, status_reason, quality, category, provider_template_id, status_changed_at) ON message_templates TO cf_app;

-- Template messages -------------------------------------------------------------------------------------------------------
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text', 'template', 'unsupported'));
ALTER TABLE messages ADD COLUMN template_id uuid;
ALTER TABLE messages ADD COLUMN template_params jsonb CHECK (template_params IS NULL OR jsonb_typeof(template_params) = 'array');
-- The template category when it was sent: Meta charges by category (usage ledger, BRD section 11).
ALTER TABLE messages ADD COLUMN pricing_category text CHECK (pricing_category IS NULL OR pricing_category IN ('marketing', 'utility', 'authentication', 'service'));
ALTER TABLE messages ADD CONSTRAINT messages_template_fk FOREIGN KEY (tenant_id, template_id) REFERENCES message_templates (tenant_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_template_complete
  CHECK ((kind = 'template') = (template_id IS NOT NULL) AND (kind = 'template') = (template_params IS NOT NULL));
GRANT UPDATE (pricing_category) ON messages TO cf_app;

-- Marketing consent --------------------------------------------------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN marketing_consent_at timestamptz;
GRANT UPDATE (marketing_consent_at) ON contacts TO cf_app;
ALTER TABLE consent_events DROP CONSTRAINT consent_events_kind_check;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_kind_check
  CHECK (kind IN ('opt_out', 'opt_in', 'marketing_opt_in', 'marketing_opt_out'));

INSERT INTO permissions (key, description, requires_mfa) VALUES
  ('templates.manage', 'Create message templates and submit them to WhatsApp for review', false);
