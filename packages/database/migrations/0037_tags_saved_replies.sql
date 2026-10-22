-- 0037 Tags and saved replies (BRD v1.2 Wave 1, CF-EXT-002 / backlog W1.6).
--
-- Tags: a company's own labels (for example "VIP", "Complaint", "Riyadh"), managed by supervisors and above and put on
-- conversations by anyone who can reply there. Saved replies: shared texts an agent inserts into the reply box and then
-- edits and sends as usual; inserting one never sends anything by itself.

CREATE TABLE tags (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40 AND name !~ '[\r\n\t]'),
  -- A fixed palette, so every colour has readable text in both themes.
  color       text NOT NULL DEFAULT 'slate' CHECK (color IN ('slate', 'teal', 'green', 'amber', 'red', 'violet', 'blue')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, id)
);
CREATE UNIQUE INDEX tags_name ON tags (tenant_id, lower(trim(name)));

CREATE TABLE conversation_tags (
  tenant_id        uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  tag_id           uuid NOT NULL,
  added_by         uuid,
  added_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id, tag_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tag_id) REFERENCES tags (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, added_by) REFERENCES memberships (tenant_id, id)
);
CREATE INDEX conversation_tags_tag ON conversation_tags (tenant_id, tag_id);

CREATE TABLE saved_replies (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 80 AND title !~ '[\r\n\t]'),
  body        text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4096),
  language    text CHECK (language IS NULL OR language IN ('en', 'ar')),
  created_by  uuid,
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES memberships (tenant_id, id)
);
CREATE UNIQUE INDEX saved_replies_title ON saved_replies (tenant_id, lower(trim(title)));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tags', 'conversation_tags', 'saved_replies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, DELETE ON tags TO cf_app;
GRANT UPDATE (name, color) ON tags TO cf_app;
GRANT SELECT, INSERT, DELETE ON conversation_tags TO cf_app;
GRANT SELECT, INSERT, DELETE ON saved_replies TO cf_app;
GRANT UPDATE (title, body, language, updated_by, updated_at) ON saved_replies TO cf_app;

ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check
  CHECK (kind IN ('assigned', 'unassigned', 'takeover', 'status_changed', 'opted_out', 'opted_in', 'paused', 'resumed', 'retried',
                  'sla_met', 'sla_missed', 'tagged', 'untagged', 'auto_assigned'));

-- Permissions, and their grant to existing companies' built-in roles (the SR-1 step from migration 0031).
INSERT INTO permissions (key, description, requires_mfa) VALUES
  ('tags.manage', 'Create, rename and delete the company''s conversation tags', false),
  ('saved_replies.manage', 'Create, edit and delete the company''s saved replies', false);
INSERT INTO system_role_grants (role_key, permission_key, added_in) VALUES
  ('owner', 'tags.manage', '0037'), ('admin', 'tags.manage', '0037'), ('supervisor', 'tags.manage', '0037'),
  ('owner', 'saved_replies.manage', '0037'), ('admin', 'saved_replies.manage', '0037'), ('supervisor', 'saved_replies.manage', '0037');
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission_key)
  SELECT r.tenant_id, r.id, g.permission_key
  FROM roles r JOIN system_role_grants g ON g.role_key = r.key
  WHERE r.is_system AND g.added_in = '0037'
  ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
