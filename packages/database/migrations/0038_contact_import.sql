-- 0038 Contact import from CSV (BRD v1.2 Wave 1, CF-EXT-003 / FR-302, backlog W1.7).
--
-- Two steps: a preview (dry run) records exactly what would happen to each row, and an import applies that preview,
-- checking every row again at that moment. Marketing consent is recorded only with the company's own statement of how
-- the customers agreed (evidence), never for a customer who has opted out, and never removed silently. An import can be
-- undone: contacts it created that have no conversation yet are removed, and marketing consent it recorded is withdrawn
-- (with a consent event saying so). Nothing is ever sent by an import.

CREATE TABLE import_batches (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_name         text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  status            text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'imported', 'undone')),
  -- How the customers marked "yes" agreed to marketing messages, in the company's words. Required when any row says yes.
  consent_evidence  text CHECK (consent_evidence IS NULL OR length(consent_evidence) BETWEEN 10 AND 500),
  -- The previewed rows (cleared to the outcome list once imported, so names and numbers are not kept twice).
  rows              jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  summary           jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  imported_by       uuid,
  imported_at       timestamptz,
  undone_by         uuid,
  undone_at         timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, id),
  FOREIGN KEY (tenant_id, imported_by) REFERENCES memberships (tenant_id, id),
  FOREIGN KEY (tenant_id, undone_by) REFERENCES memberships (tenant_id, id),
  CHECK ((status = 'previewed') = (imported_at IS NULL) AND (status = 'undone') = (undone_at IS NOT NULL))
);
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY import_batches_tenant ON import_batches FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON import_batches TO cf_app;
GRANT UPDATE (status, rows, summary, imported_by, imported_at, undone_by, undone_at) ON import_batches TO cf_app;

-- Which import created a contact (null for contacts created by a customer's message or by an agent).
ALTER TABLE contacts ADD COLUMN created_by_import uuid;
ALTER TABLE contacts ADD CONSTRAINT contacts_import_fk FOREIGN KEY (tenant_id, created_by_import) REFERENCES import_batches (tenant_id, id);

-- Undo needs to remove contacts, which the application could never do before. A trigger keeps that narrow: only a
-- contact created by an import, with no conversation, can be deleted. Everything else is refused by the database.
GRANT DELETE ON contacts TO cf_app;
CREATE FUNCTION contacts_delete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.created_by_import IS NULL OR EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = OLD.id) THEN
    RAISE EXCEPTION 'only a contact created by an import, with no conversation, can be removed' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER contacts_delete_guard BEFORE DELETE ON contacts FOR EACH ROW EXECUTE FUNCTION contacts_delete_guard();

INSERT INTO permissions (key, description, requires_mfa) VALUES
  ('contacts.import', 'Import contacts from a file, including recorded marketing consent, and undo an import', true);
INSERT INTO system_role_grants (role_key, permission_key, added_in) VALUES
  ('owner', 'contacts.import', '0038'), ('admin', 'contacts.import', '0038');
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission_key)
  SELECT r.tenant_id, r.id, g.permission_key
  FROM roles r JOIN system_role_grants g ON g.role_key = r.key
  WHERE r.is_system AND g.added_in = '0038'
  ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
