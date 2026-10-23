-- 0052 W2.5 (CF-EXT-013): notifications on agents' phones and computers (web push), first version.
--
-- A member allows notifications in their browser; the browser's push subscription is stored for that member. When a
-- customer writes in a conversation the member should see (assigned to them, or unassigned when they chose to hear
-- about unassigned conversations), or makes a request on their customer page, a notification job is queued in the
-- same transaction, so it is queued exactly once. The worker sends it.
--
-- What a notification says is kept short and contains no message text, customer name or number (it may show on a
-- locked screen): "New message from a customer" and a link to the conversation.

CREATE TABLE push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  membership_id   uuid NOT NULL,
  endpoint        text NOT NULL CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1000),
  p256dh          text NOT NULL CHECK (length(p256dh) BETWEEN 40 AND 200),
  auth            text NOT NULL CHECK (length(auth) BETWEEN 16 AND 64),
  user_agent      text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failures        integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, endpoint),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE
);

-- What each member wants to hear about. No row: only conversations assigned to them.
CREATE TABLE notification_preferences (
  tenant_id       uuid NOT NULL,
  membership_id   uuid NOT NULL,
  assigned        boolean NOT NULL DEFAULT true,
  unassigned      boolean NOT NULL DEFAULT false,
  customer_requests boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, membership_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE push_jobs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  subscription_id uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('new_message', 'customer_request', 'test')),
  conversation_id uuid,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'sent', 'failed', 'gone')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  last_error      text CHECK (last_error IS NULL OR length(last_error) <= 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES push_subscriptions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX push_jobs_due ON push_jobs (next_attempt_at) WHERE state IN ('pending', 'leased');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['push_subscriptions', 'notification_preferences', 'push_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, DELETE ON push_subscriptions TO cf_app;
GRANT UPDATE (last_success_at, failures, p256dh, auth, user_agent) ON push_subscriptions TO cf_app;
GRANT SELECT, INSERT ON notification_preferences TO cf_app;
GRANT UPDATE (assigned, unassigned, customer_requests, updated_at) ON notification_preferences TO cf_app;
GRANT SELECT, INSERT ON push_jobs TO cf_app;
GRANT UPDATE (state, attempts, next_attempt_at, lease_until, last_error, updated_at) ON push_jobs TO cf_app;

-- The worker leases due notification jobs across companies (scheduling columns only), like the other job queues.
GRANT SELECT (id, tenant_id, state, next_attempt_at, lease_until) ON push_jobs TO cf_dispatch;
GRANT UPDATE (state, lease_until, updated_at) ON push_jobs TO cf_dispatch;
CREATE POLICY push_jobs_dispatch_read ON push_jobs FOR SELECT TO cf_dispatch USING (state IN ('pending', 'leased'));
CREATE POLICY push_jobs_dispatch_lease ON push_jobs FOR UPDATE TO cf_dispatch
  USING (state IN ('pending', 'leased')) WITH CHECK (state = 'leased');

CREATE FUNCTION push_claim(p_limit integer, p_lease_seconds integer) RETURNS TABLE (job_id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE push_jobs j SET state = 'leased', lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 600)), updated_at = now()
  WHERE j.id IN (
    SELECT s.id FROM push_jobs s
    WHERE (s.state = 'pending' AND s.next_attempt_at <= now()) OR (s.state = 'leased' AND s.lease_until < now())
    ORDER BY s.next_attempt_at
    LIMIT least(greatest(p_limit, 1), 200)
    FOR UPDATE SKIP LOCKED)
    AND ((j.state = 'pending' AND j.next_attempt_at <= now()) OR (j.state = 'leased' AND j.lease_until < now()))
  RETURNING j.id, j.tenant_id
$$;
ALTER FUNCTION push_claim(integer, integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION push_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_claim(integer, integer) TO cf_app;
