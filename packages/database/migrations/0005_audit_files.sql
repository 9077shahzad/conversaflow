-- 0005 Audit trail (append-only, hash-chained per company) and file records.

CREATE TABLE audit_events (
  id            uuid NOT NULL DEFAULT uuid_generate_v7() PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seq           bigint NOT NULL,
  actor_user_id uuid,
  action        text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_.]+$'),
  target_type   text,
  target_id     text,
  ip            inet,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  prev_hash     bytea,
  hash          bytea NOT NULL,
  UNIQUE (tenant_id, seq)
);

-- One definition of a row's hash, used by the insert trigger and by the verifier.
CREATE FUNCTION audit_row_hash(p_prev bytea, p_tenant uuid, p_seq bigint, p_actor uuid, p_action text,
                               p_target_type text, p_target_id text, p_metadata jsonb, p_created_at timestamptz)
RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT digest(coalesce(p_prev, ''::bytea) || convert_to(concat_ws('|',
    p_tenant::text, p_seq::text, coalesce(p_actor::text, '-'), p_action, coalesce(p_target_type, '-'),
    coalesce(p_target_id, '-'), p_metadata::text,
    to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8'), 'sha256')
$$;

CREATE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_prev audit_events%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));
  SELECT * INTO v_prev FROM audit_events WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  NEW.seq        := coalesce(v_prev.seq, 0) + 1;
  NEW.prev_hash  := v_prev.hash;
  NEW.created_at := date_trunc('microseconds', clock_timestamp());
  NEW.hash := audit_row_hash(NEW.prev_hash, NEW.tenant_id, NEW.seq, NEW.actor_user_id, NEW.action,
                             NEW.target_type, NEW.target_id, NEW.metadata, NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_chain();

CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- Returns the first sequence number whose hash does not match, or NULL when the chain is intact.
CREATE FUNCTION audit_verify_chain() RETURNS bigint LANGUAGE sql STABLE AS $$
  WITH ordered AS (
    SELECT e.*, lag(e.hash) OVER (ORDER BY e.seq) AS expected_prev, lag(e.seq) OVER (ORDER BY e.seq) AS prev_seq
    FROM audit_events e WHERE e.tenant_id = app_tenant_id()
  )
  SELECT min(seq) FROM ordered
  WHERE hash IS DISTINCT FROM audit_row_hash(prev_hash, tenant_id, seq, actor_user_id, action, target_type, target_id, metadata, created_at)
     OR prev_hash IS DISTINCT FROM expected_prev
     OR seq <> coalesce(prev_seq, 0) + 1
$$;

CREATE TABLE files (
  id            uuid NOT NULL DEFAULT uuid_generate_v7() PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  storage_key   text NOT NULL UNIQUE CHECK (storage_key ~ '^tenants/[0-9a-f-]{36}/files/[0-9a-f-]{36}$'),
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  sha256        bytea NOT NULL,
  status        text NOT NULL DEFAULT 'pending_scan' CHECK (status IN ('pending_scan', 'available', 'rejected')),
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- the storage path must sit inside this company's own folder
  CHECK (storage_key LIKE 'tenants/' || tenant_id::text || '/files/%')
);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE files        ENABLE ROW LEVEL SECURITY; ALTER TABLE files        FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_tenant_read   ON audit_events FOR SELECT TO cf_app USING (tenant_id = app_tenant_id());
CREATE POLICY audit_tenant_insert ON audit_events FOR INSERT TO cf_app WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY audit_owner         ON audit_events FOR ALL TO CURRENT_USER
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY files_tenant ON files FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT ON audit_events TO cf_app;
GRANT EXECUTE ON FUNCTION audit_verify_chain() TO cf_app;
GRANT SELECT, INSERT, UPDATE ON files TO cf_app;
