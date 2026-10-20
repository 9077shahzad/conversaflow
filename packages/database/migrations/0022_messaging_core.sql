-- 0022 Messaging core, slice 1 of BRD v1.2 Wave 1 (CF-EXT-001/002/003; FR-101–108, FR-201–204, FR-301).
-- Channel connections, verified webhook intake with de-duplication, contacts with verified identifiers, consent
-- history, conversations, messages and an append-only conversation history.
-- Every table is company-owned, has tenant_id, and is under forced row-level security for cf_app.
-- Histories (consent, conversation events, notes) are append-only: no UPDATE or DELETE is granted.
-- No company exists outside local tests yet, so the new permissions are added to roles created from now on
-- (apps/api/src/modules/rbac.ts); there are no existing roles to back-fill.

INSERT INTO permissions (key, description, requires_mfa) VALUES
  ('inbox.assign',    'Assign conversations to others and take over a conversation from another person', false),
  ('channels.manage', 'Connect and manage messaging channels', true);

-- Channels ----------------------------------------------------------------------------------------------------
CREATE TABLE channel_connections (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'sandbox' is the local test double (never touches the network); 'whatsapp_cloud' is Meta's Cloud API.
  provider           text NOT NULL CHECK (provider IN ('sandbox', 'whatsapp_cloud')),
  -- Meta's phone_number_id. Unique across the platform: one number can never be claimed by two companies (FR-105).
  provider_number_id text NOT NULL CHECK (provider_number_id ~ '^[0-9A-Za-z_-]{3,64}$'),
  display_phone      text NOT NULL CHECK (length(display_phone) BETWEEN 3 AND 32),
  label              text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_number_id),
  UNIQUE (tenant_id, id)
);

-- Webhook intake ---------------------------------------------------------------------------------------------
-- One row per provider event (a webhook delivery can carry several). The unique key makes a repeated delivery a
-- no-op, so retries and duplicates never repeat a business action (BRD §18 gate 2).
CREATE TABLE webhook_events (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  event_key     text NOT NULL CHECK (length(event_key) BETWEEN 3 AND 300),
  kind          text NOT NULL CHECK (kind IN ('message', 'status')),
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  -- applied | stale_status (older than what we have) | orphan_status (for a message not recorded yet; applied later)
  outcome       text CHECK (outcome IN ('applied', 'stale_status', 'orphan_status')),
  UNIQUE (tenant_id, connection_id, event_key),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES channel_connections (tenant_id, id)
);

-- Contacts ----------------------------------------------------------------------------------------------------
CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name  text CHECK (display_name IS NULL OR length(display_name) <= 200),
  locale        text CHECK (locale IS NULL OR locale IN ('en', 'ar')),
  -- Set when the person opts out; every outbound route checks it (FR-108). Cleared only by the person opting in.
  opted_out_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Identities are never merged on names: only a verified identifier links a message to a contact (CF-EXT-003).
CREATE TABLE contact_identifiers (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL,
  contact_id  uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('whatsapp')),
  value       text NOT NULL CHECK (value ~ '^[0-9]{6,20}$'),
  verified    boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, value),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE consent_events (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL,
  contact_id  uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('opt_out', 'opt_in')),
  channel     text NOT NULL CHECK (channel IN ('whatsapp')),
  source      text NOT NULL CHECK (source IN ('inbound_keyword', 'agent_recorded', 'import')),
  -- What proves it, e.g. the provider message id of the customer's "STOP".
  evidence    text CHECK (evidence IS NULL OR length(evidence) <= 300),
  recorded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);

-- Conversations and messages ----------------------------------------------------------------------------------
CREATE TABLE conversations (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id              uuid NOT NULL,
  contact_id             uuid NOT NULL,
  connection_id          uuid NOT NULL,
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved')),
  assigned_membership_id uuid,
  -- Latest customer message by the provider's timestamp: starts the 24-hour customer service window.
  last_inbound_at        timestamptz,
  -- Newest message in the thread by provider/creation time; a reply must name it (collision check, CF-EXT-002).
  last_message_id        uuid,
  last_message_at        timestamptz,
  -- Bumped by every change; assignment uses it for optimistic concurrency.
  version                integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, connection_id) REFERENCES channel_connections (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_membership_id) REFERENCES memberships (tenant_id, id)
);
-- At most one unresolved conversation per contact and channel.
CREATE UNIQUE INDEX conversations_one_open ON conversations (tenant_id, contact_id, connection_id) WHERE status <> 'resolved';
CREATE INDEX conversations_inbox ON conversations (tenant_id, status, last_message_at DESC);

CREATE TABLE messages (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id             uuid NOT NULL,
  conversation_id       uuid NOT NULL,
  direction             text NOT NULL CHECK (direction IN ('in', 'out')),
  kind                  text NOT NULL CHECK (kind IN ('text', 'unsupported')),
  body                  text CHECK (body IS NULL OR length(body) <= 4096),
  -- The provider's own type when we do not handle it yet (image, location ...), for display only.
  provider_type         text CHECK (provider_type IS NULL OR length(provider_type) <= 40),
  provider_message_id   text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 200),
  -- Outbound only: the sender's idempotency key, so a retried send never sends twice.
  client_message_id     uuid,
  sent_by_membership_id uuid,
  -- When the provider says it happened (inbound) or when we created it (outbound). Orders the thread.
  occurred_at           timestamptz NOT NULL,
  status                text NOT NULL CHECK (status IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
  error_code            text CHECK (error_code IS NULL OR length(error_code) <= 100),
  -- Click-to-WhatsApp referral data as received (CF-EXT-005), stored for attribution; never trusted for actions.
  referral              jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_message_id),
  UNIQUE (tenant_id, client_message_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sent_by_membership_id) REFERENCES memberships (tenant_id, id),
  CHECK ((direction = 'in') = (status = 'received')),
  CHECK (direction = 'in' OR client_message_id IS NOT NULL)
);
CREATE INDEX messages_thread ON messages (tenant_id, conversation_id, occurred_at, id);

CREATE TABLE internal_notes (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id            uuid NOT NULL,
  conversation_id      uuid NOT NULL,
  author_membership_id uuid NOT NULL,
  body                 text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_membership_id) REFERENCES memberships (tenant_id, id)
);

CREATE TABLE conversation_events (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           uuid NOT NULL,
  conversation_id     uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('assigned', 'unassigned', 'takeover', 'status_changed', 'opted_out', 'opted_in')),
  actor_membership_id uuid,
  data                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);

-- Row-level security -------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_connections', 'webhook_events', 'contacts', 'contact_identifiers', 'consent_events',
                           'conversations', 'messages', 'internal_notes', 'conversation_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
                   t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON channel_connections TO cf_app;
GRANT UPDATE (label, status) ON channel_connections TO cf_app;
GRANT SELECT, INSERT ON webhook_events TO cf_app;
GRANT UPDATE (processed_at, outcome) ON webhook_events TO cf_app;
GRANT SELECT, INSERT ON contacts TO cf_app;
GRANT UPDATE (display_name, locale, opted_out_at, updated_at) ON contacts TO cf_app;
GRANT SELECT, INSERT ON contact_identifiers, consent_events, internal_notes, conversation_events TO cf_app;
GRANT SELECT, INSERT ON conversations TO cf_app;
GRANT UPDATE (status, assigned_membership_id, last_inbound_at, last_message_id, last_message_at, version) ON conversations TO cf_app;
GRANT SELECT, INSERT ON messages TO cf_app;
GRANT UPDATE (status, error_code, provider_message_id) ON messages TO cf_app;

-- Webhook routing ----------------------------------------------------------------------------------------------
-- A verified webhook names a provider number, not a company. This one lookup (owned by cf_channel, which can read
-- only the routing columns) tells the API which company and connection the number belongs to, so the event can then
-- be stored inside that company's context under ordinary row-level security. Disabled connections do not route.
GRANT USAGE, CREATE ON SCHEMA public TO cf_channel;
GRANT SELECT (id, tenant_id, provider, provider_number_id, status) ON channel_connections TO cf_channel;
CREATE POLICY channel_connections_route ON channel_connections FOR SELECT TO cf_channel USING (status = 'active');

CREATE FUNCTION channel_route(p_provider text, p_number text) RETURNS TABLE (tenant_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.tenant_id, c.id FROM channel_connections c
  WHERE c.provider = p_provider AND c.provider_number_id = p_number AND c.status = 'active'
$$;
ALTER FUNCTION channel_route(text, text) OWNER TO cf_channel;
REVOKE ALL ON FUNCTION channel_route(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_route(text, text) TO cf_app;
