-- 0056 W2.8 (CF-EXT-016): public API v1 and outgoing webhooks, first version.
--
-- API keys: created by a member with api.manage for themselves; a key acts as that member, limited to the scopes
-- chosen, and stops working when it is revoked, expires, or the member loses access. Only a SHA-256 of the secret
-- is stored; the key is shown once. Requests are looked up through one reviewed function owned by cf_channel.
-- Every API request is logged (method, route, status, time) without bodies.
--
-- Outgoing webhooks: the company registers https endpoints for chosen events. Each delivery is signed
-- (HMAC-SHA256 over timestamp and body), retried with back-off, recorded with its response code, and can be sent
-- again by hand. A signing secret can be rotated; the previous one keeps working for 24 hours.

CREATE TABLE api_keys (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  membership_id   uuid NOT NULL,
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  -- Shown in lists so a key can be recognised: "cf_live_ab12cd34…".
  prefix          text NOT NULL CHECK (prefix ~ '^[a-z0-9]{8}$'),
  secret_hash     bytea NOT NULL UNIQUE CHECK (length(secret_hash) = 32),
  scopes          text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 10
                    AND scopes <@ ARRAY['conversations:read', 'messages:send', 'contacts:read', 'contacts:write', 'reports:read']::text[]),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz CHECK (expires_at IS NULL OR expires_at > created_at),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users(id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE api_request_log (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL,
  api_key_id  uuid NOT NULL,
  method      text NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  route       text NOT NULL CHECK (length(route) <= 120),
  status      integer NOT NULL CHECK (status BETWEEN 100 AND 599),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, api_key_id) REFERENCES api_keys (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX api_request_log_key ON api_request_log (tenant_id, api_key_id, created_at DESC);

-- Messages sent through the API say so (and by which key), next to the member the key acts for.
ALTER TABLE messages ADD COLUMN api_key_id uuid;
ALTER TABLE messages ADD CONSTRAINT messages_api_key_fk FOREIGN KEY (tenant_id, api_key_id) REFERENCES api_keys (tenant_id, id) ON DELETE SET NULL (api_key_id);
GRANT INSERT (api_key_id) ON messages TO cf_app;

CREATE TABLE webhook_endpoints (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url             text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 500),
  events          text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 10
                    AND events <@ ARRAY['message.received', 'message.status', 'conversation.resolved', 'customer_request.created', 'promise.missed']::text[]),
  secret          text NOT NULL CHECK (length(secret) BETWEEN 32 AND 100),
  previous_secret text CHECK (previous_secret IS NULL OR length(previous_secret) BETWEEN 32 AND 100),
  previous_until  timestamptz,
  enabled         boolean NOT NULL DEFAULT true,
  description     text CHECK (description IS NULL OR length(description) <= 200),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  failures        integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id)
);

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  endpoint_id     uuid NOT NULL,
  event           text NOT NULL CHECK (length(event) <= 60),
  -- The event id the receiver uses to drop duplicates; a manual resend keeps it.
  event_id        uuid NOT NULL,
  payload         jsonb NOT NULL,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'delivered', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  last_status     integer,
  last_error      text CHECK (last_error IS NULL OR length(last_error) <= 200),
  delivered_at    timestamptz,
  resend_of       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES webhook_endpoints (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE state IN ('pending', 'leased');
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (tenant_id, endpoint_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys', 'api_request_log', 'webhook_endpoints', 'webhook_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON api_keys, api_request_log, webhook_endpoints, webhook_deliveries TO cf_app;
GRANT UPDATE (last_used_at, revoked_at, revoked_by) ON api_keys TO cf_app;
GRANT UPDATE (url, events, secret, previous_secret, previous_until, enabled, description, failures) ON webhook_endpoints TO cf_app;
GRANT DELETE ON webhook_endpoints TO cf_app;
GRANT UPDATE (state, attempts, next_attempt_at, lease_until, last_status, last_error, delivered_at, updated_at) ON webhook_deliveries TO cf_app;

-- Key lookup: the hash of the presented secret in, the key's company, member and scopes out, only for a key that is
-- neither revoked nor expired. cf_channel may read just these columns (pinned in check-rls.ts).
GRANT SELECT (id, tenant_id, membership_id, secret_hash, scopes, expires_at, revoked_at) ON api_keys TO cf_channel;
CREATE POLICY api_keys_route ON api_keys FOR SELECT TO cf_channel USING (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()));
CREATE FUNCTION api_key_route(p_hash bytea) RETURNS TABLE (key_id uuid, tenant_id uuid, membership_id uuid, scopes text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.id, k.tenant_id, k.membership_id, k.scopes FROM api_keys k
  WHERE k.secret_hash = p_hash AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
$$;
ALTER FUNCTION api_key_route(bytea) OWNER TO cf_channel;
REVOKE ALL ON FUNCTION api_key_route(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_route(bytea) TO cf_app;

-- Delivery leasing for the worker (scheduling columns only).
GRANT SELECT (id, tenant_id, state, next_attempt_at, lease_until) ON webhook_deliveries TO cf_dispatch;
GRANT UPDATE (state, lease_until, updated_at) ON webhook_deliveries TO cf_dispatch;
CREATE POLICY webhook_deliveries_dispatch_read ON webhook_deliveries FOR SELECT TO cf_dispatch USING (state IN ('pending', 'leased'));
CREATE POLICY webhook_deliveries_dispatch_lease ON webhook_deliveries FOR UPDATE TO cf_dispatch
  USING (state IN ('pending', 'leased')) WITH CHECK (state = 'leased');
CREATE FUNCTION webhook_claim(p_limit integer, p_lease_seconds integer) RETURNS TABLE (delivery_id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE webhook_deliveries d SET state = 'leased', lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 600)), updated_at = now()
  WHERE d.id IN (
    SELECT s.id FROM webhook_deliveries s
    WHERE (s.state = 'pending' AND s.next_attempt_at <= now()) OR (s.state = 'leased' AND s.lease_until < now())
    ORDER BY s.next_attempt_at
    LIMIT least(greatest(p_limit, 1), 200)
    FOR UPDATE SKIP LOCKED)
    AND ((d.state = 'pending' AND d.next_attempt_at <= now()) OR (d.state = 'leased' AND d.lease_until < now()))
  RETURNING d.id, d.tenant_id
$$;
ALTER FUNCTION webhook_claim(integer, integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION webhook_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_claim(integer, integer) TO cf_app;

INSERT INTO permissions (key, description, requires_mfa) VALUES
  ('api.manage', 'Create API keys and outgoing webhooks for the company''s own systems', true);
INSERT INTO system_role_grants (role_key, permission_key, added_in) VALUES ('owner', 'api.manage', '0056'), ('admin', 'api.manage', '0056');
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission_key)
  SELECT r.tenant_id, r.id, g.permission_key FROM roles r JOIN system_role_grants g ON g.role_key = r.key
  WHERE r.is_system AND g.added_in = '0056'
  ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
