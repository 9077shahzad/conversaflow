-- 0024 Slice 2 of BRD v1.2 Wave 1 (owner decisions of 20 Oct 2026).
--  1. Reliable background sending: one send job per outbound message, leased by the worker. A message is marked
--     'submitting' (committed) before the provider is called; if the outcome is unknown it becomes 'uncertain' and is
--     never re-sent automatically. Retries happen only when the provider definitely did not accept the message.
--     A person can retry a failed or uncertain message; the retry is a new message linked to the original.
--  2. "Pause replies / supervisor handling": an explicit, permissioned pause with a visible reason and an expiry or
--     manual release, enforced on the server for replies and again at send time. Ordinary notes never block replies.
--  3. Verified number ownership is required before any live WhatsApp connection can exist.

-- Messages --------------------------------------------------------------------------------------------------------
ALTER TABLE messages DROP CONSTRAINT messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('received', 'queued', 'submitting', 'sent', 'delivered', 'read', 'failed', 'uncertain'));
ALTER TABLE messages ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0);
ALTER TABLE messages ADD COLUMN retry_of uuid;
ALTER TABLE messages ADD CONSTRAINT messages_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_retry_of_fk FOREIGN KEY (tenant_id, retry_of) REFERENCES messages (tenant_id, id);
-- Only one retry per original, so two people pressing "retry" cannot send it twice.
CREATE UNIQUE INDEX messages_one_retry ON messages (tenant_id, retry_of) WHERE retry_of IS NOT NULL;
GRANT UPDATE (attempts) ON messages TO cf_app;

-- Send jobs ---------------------------------------------------------------------------------------------------------
CREATE TABLE send_jobs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'done', 'dead')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  last_error      text CHECK (last_error IS NULL OR length(last_error) <= 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, message_id),           -- one job per message, ever: a duplicate job cannot exist
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX send_jobs_due ON send_jobs (next_attempt_at) WHERE state IN ('pending', 'leased');
ALTER TABLE send_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY send_jobs_tenant ON send_jobs FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON send_jobs TO cf_app;
GRANT UPDATE (state, attempts, next_attempt_at, lease_until, last_error, updated_at) ON send_jobs TO cf_app;

-- The worker finds due jobs across companies through one lookup, owned by cf_dispatch (NOLOGIN), which can see and
-- lease jobs but no message content. Each job is then processed as cf_app inside its company's context.
GRANT USAGE, CREATE ON SCHEMA public TO cf_dispatch;
GRANT SELECT (id, tenant_id, state, next_attempt_at, lease_until) ON send_jobs TO cf_dispatch;
GRANT UPDATE (state, lease_until, updated_at) ON send_jobs TO cf_dispatch;
CREATE POLICY send_jobs_dispatch_read ON send_jobs FOR SELECT TO cf_dispatch USING (state IN ('pending', 'leased'));
CREATE POLICY send_jobs_dispatch_lease ON send_jobs FOR UPDATE TO cf_dispatch
  USING (state IN ('pending', 'leased')) WITH CHECK (state = 'leased');

CREATE FUNCTION dispatch_claim(p_limit integer, p_lease_seconds integer) RETURNS TABLE (job_id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE send_jobs j SET state = 'leased', lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 600)),
                         updated_at = now()
  WHERE j.id IN (
    SELECT s.id FROM send_jobs s
    WHERE (s.state = 'pending' AND s.next_attempt_at <= now()) OR (s.state = 'leased' AND s.lease_until < now())
    ORDER BY s.next_attempt_at
    LIMIT least(greatest(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED)
  RETURNING j.id, j.tenant_id
$$;
ALTER FUNCTION dispatch_claim(integer, integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION dispatch_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dispatch_claim(integer, integer) TO cf_app;

-- Reply pause --------------------------------------------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN paused_by_membership_id uuid;
ALTER TABLE conversations ADD COLUMN paused_reason text CHECK (paused_reason IS NULL OR length(trim(paused_reason)) BETWEEN 3 AND 300);
ALTER TABLE conversations ADD COLUMN paused_at timestamptz;
-- NULL with paused_at set means "until released by hand".
ALTER TABLE conversations ADD COLUMN paused_until timestamptz;
ALTER TABLE conversations ADD CONSTRAINT conversations_paused_by_fk
  FOREIGN KEY (tenant_id, paused_by_membership_id) REFERENCES memberships (tenant_id, id);
ALTER TABLE conversations ADD CONSTRAINT conversations_pause_complete
  CHECK ((paused_at IS NULL) = (paused_by_membership_id IS NULL) AND (paused_at IS NULL) = (paused_reason IS NULL)
         AND (paused_until IS NULL OR paused_at IS NOT NULL));
GRANT UPDATE (paused_by_membership_id, paused_reason, paused_at, paused_until) ON conversations TO cf_app;

ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check
  CHECK (kind IN ('assigned', 'unassigned', 'takeover', 'status_changed', 'opted_out', 'opted_in', 'paused', 'resumed', 'retried'));

INSERT INTO permissions (key, description, requires_mfa) VALUES
  ('inbox.pause', 'Pause replies on a conversation while a supervisor handles it', false);

-- Verified number ownership ----------------------------------------------------------------------------------------------
-- A live connection must carry proof that the company controls the number (set only by the future onboarding flow,
-- e.g. Meta Embedded Signup v4, through a reviewed function). The business role can no longer insert those columns,
-- so it cannot create a live connection at all.
ALTER TABLE channel_connections ADD COLUMN ownership_verified_at timestamptz;
ALTER TABLE channel_connections ADD COLUMN ownership_method text CHECK (ownership_method IS NULL OR ownership_method IN ('embedded_signup_v4'));
ALTER TABLE channel_connections ADD CONSTRAINT channel_connections_live_needs_ownership
  CHECK (provider <> 'whatsapp_cloud' OR (ownership_verified_at IS NOT NULL AND ownership_method IS NOT NULL));
REVOKE INSERT ON channel_connections FROM cf_app;
GRANT INSERT (tenant_id, provider, provider_number_id, display_phone, label, created_by) ON channel_connections TO cf_app;
