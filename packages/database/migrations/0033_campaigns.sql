-- 0033 Campaigns (BRD v1.2 Wave 1, CF-EXT-004; owner instructions of 21 Oct 2026).
-- A campaign sends one approved template to an audience of contacts who have RECORDED consent. Recipients are chosen
-- when the campaign starts (not when it is scheduled), and every recipient is checked again immediately before their
-- message is queued and again by the sender just before it leaves: opt-out (including one received after scheduling),
-- consent, suppression list, frequency limit, template still approved, campaign still running.
--
-- No duplicate sending: one recipient row per contact per campaign; each recipient's message uses the recipient id as
-- its idempotency key, so a second attempt to queue it fails on the existing unique key; recipient and message are
-- written in the same transaction, so a crash leaves either both or neither.

-- Company limits ------------------------------------------------------------------------------------------------------
ALTER TABLE tenant_settings ADD COLUMN campaign_max_per_contact_7d int NOT NULL DEFAULT 2 CHECK (campaign_max_per_contact_7d BETWEEN 1 AND 14);
ALTER TABLE tenant_settings ADD COLUMN campaign_min_gap_hours int NOT NULL DEFAULT 24 CHECK (campaign_min_gap_hours BETWEEN 0 AND 168);
-- Messages a number may start in a rolling 24 hours. Meta starts business portfolios at 250 unique customers per
-- rolling 24 hours (messaging limits page, read 20 Oct 2026); the company may lower it, never raise it above its tier.
ALTER TABLE tenant_settings ADD COLUMN campaign_daily_limit int NOT NULL DEFAULT 250 CHECK (campaign_daily_limit BETWEEN 1 AND 100000);

-- Suppression list: numbers that must never receive campaigns, whatever their consent says. -------------------------
CREATE TABLE suppressions (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wa_number   text NOT NULL CHECK (wa_number ~ '^[0-9]{6,20}$'),
  reason      text NOT NULL CHECK (reason IN ('customer_request', 'complaint', 'legal', 'wrong_number', 'other')),
  note        text CHECK (note IS NULL OR length(note) <= 300),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wa_number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, id)
);

-- Campaigns -------------------------------------------------------------------------------------------------------------
CREATE TABLE campaigns (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  connection_id  uuid NOT NULL,
  template_id    uuid NOT NULL,
  -- [{ "source": "static", "value": "..." } | { "source": "contact_name", "fallback": "..." }], one per parameter
  params         jsonb NOT NULL CHECK (jsonb_typeof(params) = 'array'),
  -- { "recentDays": 1..365 | null }: only contacts who wrote within that many days; consent is always required
  audience       jsonb NOT NULL CHECK (jsonb_typeof(audience) = 'object'),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'cancelled', 'completed')),
  scheduled_at   timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  status_changed_by uuid,
  status_changed_at timestamptz,
  lease_until    timestamptz,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES channel_connections (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES message_templates (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, id),
  FOREIGN KEY (tenant_id, status_changed_by) REFERENCES memberships (tenant_id, id),
  CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL)
);
CREATE INDEX campaigns_due ON campaigns (scheduled_at) WHERE status IN ('scheduled', 'running');

CREATE TABLE campaign_recipients (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id    uuid NOT NULL,
  campaign_id  uuid NOT NULL,
  contact_id   uuid NOT NULL,
  -- pending: not yet checked | queued: message created | skipped: not eligible at send time (skip_reason)
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'skipped')),
  skip_reason  text CHECK (skip_reason IS NULL OR skip_reason IN ('opted_out', 'no_consent', 'suppressed', 'frequency_limit',
                 'no_whatsapp', 'template_not_approved', 'campaign_cancelled', 'replies_paused')),
  message_id   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id),                 -- one recipient per contact per campaign
  UNIQUE (tenant_id, message_id),                   -- one message per recipient
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id),
  CHECK ((state = 'skipped') = (skip_reason IS NOT NULL) AND (state = 'queued') = (message_id IS NOT NULL))
);
CREATE INDEX campaign_recipients_pending ON campaign_recipients (campaign_id) WHERE state = 'pending';

ALTER TABLE messages ADD COLUMN campaign_id uuid;
ALTER TABLE messages ADD CONSTRAINT messages_campaign_fk FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_campaign_is_template CHECK (campaign_id IS NULL OR kind = 'template');
CREATE INDEX messages_campaign ON messages (tenant_id, campaign_id) WHERE campaign_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppressions', 'campaigns', 'campaign_recipients'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, DELETE ON suppressions TO cf_app;
GRANT UPDATE (reason, note) ON suppressions TO cf_app;
GRANT SELECT, INSERT ON campaigns TO cf_app;
GRANT UPDATE (status, scheduled_at, started_at, finished_at, status_changed_by, status_changed_at, lease_until, updated_at) ON campaigns TO cf_app;
GRANT SELECT, INSERT ON campaign_recipients TO cf_app;
GRANT UPDATE (state, skip_reason, message_id, updated_at) ON campaign_recipients TO cf_app;
GRANT UPDATE (campaign_max_per_contact_7d, campaign_min_gap_hours, campaign_daily_limit) ON tenant_settings TO cf_app;

-- The worker finds due campaigns across companies through one lookup owned by cf_dispatch, which sees scheduling
-- columns only (no names, templates, audiences or recipients). Each campaign is then processed as cf_app.
GRANT SELECT (id, tenant_id, status, scheduled_at, lease_until) ON campaigns TO cf_dispatch;
GRANT UPDATE (lease_until, updated_at) ON campaigns TO cf_dispatch;
CREATE POLICY campaigns_dispatch_read ON campaigns FOR SELECT TO cf_dispatch USING (status IN ('scheduled', 'running'));
CREATE POLICY campaigns_dispatch_lease ON campaigns FOR UPDATE TO cf_dispatch
  USING (status IN ('scheduled', 'running')) WITH CHECK (status IN ('scheduled', 'running'));

CREATE FUNCTION campaign_claim(p_limit integer, p_lease_seconds integer) RETURNS TABLE (campaign_id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE campaigns c SET lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 600)), updated_at = now()
  WHERE c.id IN (
    SELECT s.id FROM campaigns s
    WHERE s.status IN ('scheduled', 'running') AND s.scheduled_at <= now() AND (s.lease_until IS NULL OR s.lease_until < now())
    ORDER BY s.scheduled_at
    LIMIT least(greatest(p_limit, 1), 20)
    FOR UPDATE SKIP LOCKED)
  RETURNING c.id, c.tenant_id
$$;
ALTER FUNCTION campaign_claim(integer, integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION campaign_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campaign_claim(integer, integer) TO cf_app;

-- Permission, and its grant to existing companies' built-in roles (the SR-1 step from migration 0031). -----------------
INSERT INTO permissions (key, description, requires_mfa) VALUES
  ('campaigns.manage', 'Create, schedule, pause and cancel campaigns, and manage the suppression list', true);
INSERT INTO system_role_grants (role_key, permission_key, added_in) VALUES
  ('owner', 'campaigns.manage', '0033'), ('admin', 'campaigns.manage', '0033');
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission_key)
  SELECT r.tenant_id, r.id, g.permission_key
  FROM roles r JOIN system_role_grants g ON g.role_key = r.key
  WHERE r.is_system AND g.added_in = '0033'
  ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
