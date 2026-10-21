-- 0031 Permissions added after a company was created reach its built-in roles (open item SR-1).
-- New companies get their built-in roles from the application's role definitions. Companies created earlier kept the
-- permission set of their day: migrations 0022, 0024, 0026 and 0029 added permissions to the catalogue but not to
-- existing roles (the migration owner is subject to forced row-level security and saw no rows).
--
-- system_role_grants lists, for each built-in role, the permissions added after the first release. This migration adds
-- exactly those to every company's built-in roles (is_system), and nothing else:
--   * custom roles are never touched;
--   * permissions are only added, never removed;
--   * an existing grant is left as it is (ON CONFLICT DO NOTHING), so repeating the step changes nothing.
-- Later migrations that add a permission add a row here and repeat the same step.

CREATE TABLE system_role_grants (
  role_key       text NOT NULL CHECK (role_key IN ('owner', 'admin', 'supervisor', 'agent', 'analyst')),
  permission_key text NOT NULL REFERENCES permissions(key),
  added_in       text NOT NULL CHECK (added_in ~ '^[0-9]{4}$'),
  PRIMARY KEY (role_key, permission_key)
);
GRANT SELECT ON system_role_grants TO cf_app;

INSERT INTO system_role_grants (role_key, permission_key, added_in) VALUES
  ('owner', 'inbox.assign', '0022'), ('owner', 'channels.manage', '0022'), ('owner', 'inbox.pause', '0024'),
  ('owner', 'templates.manage', '0026'), ('owner', 'channels.monitor', '0029'),
  ('admin', 'inbox.assign', '0022'), ('admin', 'channels.manage', '0022'), ('admin', 'inbox.pause', '0024'),
  ('admin', 'templates.manage', '0026'), ('admin', 'channels.monitor', '0029'),
  ('supervisor', 'inbox.assign', '0022'), ('supervisor', 'inbox.pause', '0024'),
  ('supervisor', 'templates.manage', '0026'), ('supervisor', 'channels.monitor', '0029');

-- Applied across companies with FORCE switched off inside this migration's transaction only.
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission_key)
  SELECT r.tenant_id, r.id, g.permission_key
  FROM roles r JOIN system_role_grants g ON g.role_key = r.key
  WHERE r.is_system
  ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
