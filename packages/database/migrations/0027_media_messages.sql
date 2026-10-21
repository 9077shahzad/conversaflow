-- 0027 Media messages (BRD v1.2 Wave 1).
-- Inbound: the webhook records the message with the provider's media id at once; a background job downloads the
-- file, checks it for malware and stores it as a company file. Nothing reaches a person until the scan says clean.
-- Meta media ids from webhooks expire after 7 days and download links after 5 minutes (Meta media page, read
-- 21 Oct 2026, page undated), so downloads run promptly with bounded retries.
-- Outbound: an agent attaches a file that is already stored and scanned clean in the same company.

ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text', 'template', 'media', 'unsupported'));
ALTER TABLE messages ADD COLUMN media_type text CHECK (media_type IS NULL OR media_type IN ('image', 'audio', 'video', 'document', 'sticker'));
-- pending: not downloaded yet | available: scanned clean and stored | rejected: failed the malware check |
-- unsupported: a type we do not accept | too_large: above our limit | failed: could not be downloaded (e.g. expired)
ALTER TABLE messages ADD COLUMN media_status text
  CHECK (media_status IS NULL OR media_status IN ('pending', 'available', 'rejected', 'unsupported', 'too_large', 'failed'));
ALTER TABLE messages ADD COLUMN provider_media_id text CHECK (provider_media_id IS NULL OR length(provider_media_id) <= 200);
ALTER TABLE messages ADD COLUMN media_mime text CHECK (media_mime IS NULL OR length(media_mime) <= 120);
-- The customer's file name for documents, as sent (display only; never part of a storage path).
ALTER TABLE messages ADD COLUMN media_filename text CHECK (media_filename IS NULL OR length(media_filename) <= 255);
ALTER TABLE messages ADD COLUMN file_id uuid;
ALTER TABLE messages ADD CONSTRAINT messages_file_fk FOREIGN KEY (tenant_id, file_id) REFERENCES files (tenant_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_media_complete
  CHECK ((kind = 'media') = (media_type IS NOT NULL) AND (kind = 'media') = (media_status IS NOT NULL)
         AND (media_status IS DISTINCT FROM 'available' OR file_id IS NOT NULL));
GRANT UPDATE (media_status, file_id, media_mime) ON messages TO cf_app;

-- Download jobs: one per inbound media message, leased like send jobs.
CREATE TABLE media_jobs (
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
  UNIQUE (tenant_id, message_id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX media_jobs_due ON media_jobs (next_attempt_at) WHERE state IN ('pending', 'leased');
ALTER TABLE media_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY media_jobs_tenant ON media_jobs FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON media_jobs TO cf_app;
GRANT UPDATE (state, attempts, next_attempt_at, lease_until, last_error, updated_at) ON media_jobs TO cf_app;

-- The same narrow leasing role as send jobs: scheduling columns only, no message content.
GRANT SELECT (id, tenant_id, state, next_attempt_at, lease_until) ON media_jobs TO cf_dispatch;
GRANT UPDATE (state, lease_until, updated_at) ON media_jobs TO cf_dispatch;
CREATE POLICY media_jobs_dispatch_read ON media_jobs FOR SELECT TO cf_dispatch USING (state IN ('pending', 'leased'));
CREATE POLICY media_jobs_dispatch_lease ON media_jobs FOR UPDATE TO cf_dispatch
  USING (state IN ('pending', 'leased')) WITH CHECK (state = 'leased');

CREATE FUNCTION media_claim(p_limit integer, p_lease_seconds integer) RETURNS TABLE (job_id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE media_jobs j SET state = 'leased', lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 600)),
                          updated_at = now()
  WHERE j.id IN (
    SELECT s.id FROM media_jobs s
    WHERE (s.state = 'pending' AND s.next_attempt_at <= now()) OR (s.state = 'leased' AND s.lease_until < now())
    ORDER BY s.next_attempt_at
    LIMIT least(greatest(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED)
  RETURNING j.id, j.tenant_id
$$;
ALTER FUNCTION media_claim(integer, integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION media_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_claim(integer, integer) TO cf_app;

-- Files that arrived from a customer have no uploading user; the source says where they came from.
ALTER TABLE files ADD COLUMN source text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'whatsapp_inbound'));
