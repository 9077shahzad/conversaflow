-- 0045 Automations (Wave 2, W2.1: CF-EXT-007, CF-EXT-019; FR-404–406, FR-206; acceptance items 4 and 10).
--
--  - A workflow has an editable draft and immutable published versions. Every run is pinned to the version it
--    started on, so publishing or rolling back never changes a run already under way (acceptance 4).
--  - Runs start from a trigger (an incoming message) in the same transaction that records the message, once per
--    trigger (unique key), and are carried out by the worker step by step.
--  - Safety: no cycles in a workflow (checked on publish), a step limit per run, a run limit per customer per day,
--    runs stop as soon as a person replies in the conversation or a supervisor pauses replies (FR-206).
--  - Rehearsal runs (CF-EXT-019) evaluate the same steps but only record what would have happened. The database
--    refuses any message linked to a rehearsal run, so a rehearsal can never reach a customer (acceptance 10).

CREATE TABLE workflows (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  draft              jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  current_version_id uuid,
  trigger_kind       text CHECK (trigger_kind IS NULL OR trigger_kind IN ('message_received', 'conversation_started')),
  version            int NOT NULL DEFAULT 0,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX workflows_active ON workflows (tenant_id, trigger_kind) WHERE status = 'active';

CREATE TABLE workflow_versions (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id  uuid NOT NULL,
  number       int NOT NULL CHECK (number >= 1),
  definition   jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  -- Set when this version was published by rolling back to an earlier one.
  rolled_back_from int,
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE workflows ADD CONSTRAINT workflows_current_version_fk FOREIGN KEY (tenant_id, current_version_id) REFERENCES workflow_versions (tenant_id, id);

-- Published versions never change: what a run followed can always be reproduced.
CREATE FUNCTION workflow_version_frozen() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'published workflow versions cannot be changed' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER workflow_version_frozen BEFORE UPDATE ON workflow_versions FOR EACH ROW EXECUTE FUNCTION workflow_version_frozen();

CREATE TABLE workflow_runs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id     uuid NOT NULL,
  -- The published version the run follows. A rehearsal of an unpublished draft keeps a copy of it instead.
  version_id      uuid,
  definition      jsonb CHECK (definition IS NULL OR jsonb_typeof(definition) = 'object'),
  mode            text NOT NULL CHECK (mode IN ('live', 'rehearsal')),
  -- What started the run (for example the incoming message id); one run per workflow per trigger.
  trigger_key     text NOT NULL CHECK (length(trigger_key) BETWEEN 1 AND 300),
  conversation_id uuid,
  contact_id      uuid,
  -- Rehearsal input when there is no real conversation (sample message, language).
  sample          jsonb,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'stopped', 'skipped')),
  current_step    text,
  steps_taken     int NOT NULL DEFAULT 0 CHECK (steps_taken BETWEEN 0 AND 1000),
  next_at         timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  -- Why it stopped, failed or was skipped (a short code).
  reason          text CHECK (reason IS NULL OR length(reason) <= 120),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  UNIQUE (workflow_id, trigger_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, version_id) REFERENCES workflow_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CHECK (mode = 'rehearsal' OR (conversation_id IS NOT NULL AND version_id IS NOT NULL AND definition IS NULL)),
  CHECK ((version_id IS NULL) <> (definition IS NULL))
);
CREATE INDEX workflow_runs_due ON workflow_runs (next_at) WHERE status IN ('running', 'waiting');
CREATE INDEX workflow_runs_conversation ON workflow_runs (conversation_id) WHERE status IN ('running', 'waiting');
CREATE INDEX workflow_runs_contact_day ON workflow_runs (tenant_id, workflow_id, contact_id, started_at);

-- What each step did (or, in a rehearsal, would have done).
CREATE TABLE workflow_run_steps (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id      uuid NOT NULL,
  seq         int NOT NULL CHECK (seq >= 1),
  step_id     text NOT NULL CHECK (length(step_id) BETWEEN 1 AND 60),
  kind        text NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  outcome     text NOT NULL CHECK (outcome IN ('done', 'would_do', 'skipped', 'blocked', 'failed', 'waiting')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs (tenant_id, id) ON DELETE CASCADE
);

-- Messages sent by an automation carry their run and step; at most one message per step of a run.
ALTER TABLE messages ADD COLUMN automation_run_id uuid;
ALTER TABLE messages ADD COLUMN automation_step text CHECK (automation_step IS NULL OR length(automation_step) <= 60);
ALTER TABLE messages ADD CONSTRAINT messages_automation_run_fk FOREIGN KEY (tenant_id, automation_run_id) REFERENCES workflow_runs (tenant_id, id);
CREATE UNIQUE INDEX messages_automation_step ON messages (automation_run_id, automation_step) WHERE automation_run_id IS NOT NULL;

-- Acceptance 10: a rehearsal can never produce a message.
CREATE FUNCTION messages_no_rehearsal() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.automation_run_id IS NOT NULL AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = NEW.automation_run_id AND r.mode <> 'live') THEN
    RAISE EXCEPTION 'a rehearsal run cannot send messages' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_no_rehearsal BEFORE INSERT OR UPDATE OF automation_run_id ON messages FOR EACH ROW EXECUTE FUNCTION messages_no_rehearsal();

-- Row security and grants.
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY; ALTER TABLE workflows FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE workflow_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_run_steps ENABLE ROW LEVEL SECURITY; ALTER TABLE workflow_run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY workflows_tenant ON workflows FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY workflow_versions_tenant ON workflow_versions FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY workflow_runs_tenant ON workflow_runs FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY workflow_run_steps_tenant ON workflow_run_steps FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON workflows TO cf_app;
GRANT UPDATE (name, status, draft, current_version_id, trigger_kind, version, updated_at) ON workflows TO cf_app;
GRANT SELECT, INSERT ON workflow_versions TO cf_app;
GRANT SELECT, INSERT ON workflow_runs TO cf_app;
GRANT UPDATE (status, current_step, steps_taken, next_at, lease_until, attempts, reason, finished_at) ON workflow_runs TO cf_app;
GRANT SELECT, INSERT ON workflow_run_steps TO cf_app;
GRANT INSERT (automation_run_id, automation_step) ON messages TO cf_app;

-- The worker finds due runs across companies through one lookup that sees only scheduling columns.
GRANT SELECT (id, tenant_id, status, next_at, lease_until) ON workflow_runs TO cf_dispatch;
GRANT UPDATE (lease_until) ON workflow_runs TO cf_dispatch;
CREATE POLICY workflow_runs_dispatch_read ON workflow_runs FOR SELECT TO cf_dispatch USING (status IN ('running', 'waiting'));
CREATE POLICY workflow_runs_dispatch_lease ON workflow_runs FOR UPDATE TO cf_dispatch
  USING (status IN ('running', 'waiting')) WITH CHECK (status IN ('running', 'waiting'));
CREATE FUNCTION automation_claim(p_limit integer, p_lease_seconds integer) RETURNS TABLE (run_id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE workflow_runs r SET lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 600))
  WHERE r.id IN (
    SELECT s.id FROM workflow_runs s
    WHERE s.status IN ('running', 'waiting') AND s.next_at <= now() AND (s.lease_until IS NULL OR s.lease_until < now())
    ORDER BY s.next_at
    LIMIT least(greatest(p_limit, 1), 200)
    FOR UPDATE SKIP LOCKED)
  RETURNING r.id, r.tenant_id
$$;
ALTER FUNCTION automation_claim(integer, integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION automation_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION automation_claim(integer, integer) TO cf_app;

-- Permission: automations.manage (owner, admin, supervisor), with the SR-1 backfill for existing companies.
INSERT INTO permissions (key, description, requires_mfa) VALUES ('automations.manage', 'Create, publish and roll back automations', true);
INSERT INTO system_role_grants (role_key, permission_key, added_in) VALUES
  ('owner', 'automations.manage', '0045'), ('admin', 'automations.manage', '0045'), ('supervisor', 'automations.manage', '0045');
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, g.permission_key FROM roles r JOIN system_role_grants g ON g.role_key = r.key AND g.added_in = '0045'
WHERE r.is_system ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

-- Hand-over by an automation is recorded in the conversation's history.
ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check
  CHECK (kind IN ('assigned', 'unassigned', 'takeover', 'status_changed', 'opted_out', 'opted_in', 'paused', 'resumed', 'retried',
                  'sla_met', 'sla_missed', 'tagged', 'untagged', 'auto_assigned', 'handed_off'));
