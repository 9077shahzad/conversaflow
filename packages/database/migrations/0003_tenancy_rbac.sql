-- 0003 Companies (tenants), memberships, roles and permissions, invitations.
-- Every tenant-owned table: tenant_id NOT NULL, forced RLS, composite foreign keys
-- (tenant_id, x_id) so a row can never reference another company's record.

CREATE TABLE tenants (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  slug         citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$'),
  legal_name   text NOT NULL CHECK (length(legal_name) BETWEEN 2 AND 200),
  country      char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  timezone     text NOT NULL,
  currency     char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  locale       text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar')),
  status       text NOT NULL DEFAULT 'trialing'
               CHECK (status IN ('trialing', 'active', 'past_due', 'suspended', 'closed')),
  data_region  text NOT NULL DEFAULT 'eu-provisional',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE memberships (
  id         uuid NOT NULL DEFAULT uuid_generate_v7() PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  invited_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX ON memberships (user_id);

-- Fixed permission catalogue, maintained in code and synced here by migrations.
CREATE TABLE permissions (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z_]+\.[a-z_]+$'),
  description  text NOT NULL,
  requires_mfa boolean NOT NULL DEFAULT false
);

CREATE TABLE roles (
  id         uuid NOT NULL DEFAULT uuid_generate_v7() PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name       text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, id)
);

CREATE TABLE role_permissions (
  tenant_id      uuid NOT NULL,
  role_id        uuid NOT NULL,
  permission_key text NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (tenant_id, role_id, permission_key),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE membership_roles (
  tenant_id     uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_id       uuid NOT NULL,
  PRIMARY KEY (tenant_id, membership_id, role_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id)       REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE invitations (
  id          uuid NOT NULL DEFAULT uuid_generate_v7() PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role_id     uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  invited_by  uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id)
);

-- Row-level security ---------------------------------------------------------------------------
ALTER TABLE tenants          ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants          FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships      ENABLE ROW LEVEL SECURITY; ALTER TABLE memberships      FORCE ROW LEVEL SECURITY;
ALTER TABLE roles            ENABLE ROW LEVEL SECURITY; ALTER TABLE roles            FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY; ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY; ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations      ENABLE ROW LEVEL SECURITY; ALTER TABLE invitations      FORCE ROW LEVEL SECURITY;

-- A company is visible when it is the selected company. Only when NO company is selected (the company
-- switcher) may a user list the companies they belong to. It can only be created or changed while selected.
CREATE POLICY tenants_read ON tenants FOR SELECT TO cf_app USING (
  id = app_tenant_id()
  OR (app_tenant_id() IS NULL
      AND id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app_user_id() AND m.status = 'active')));
CREATE POLICY tenants_insert ON tenants FOR INSERT TO cf_app WITH CHECK (id = app_tenant_id());
CREATE POLICY tenants_update ON tenants FOR UPDATE TO cf_app
  USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());

-- Memberships: rows of the selected company. A user's own rows in other companies are visible only when
-- no company is selected (sign-in and the switcher), never alongside another company's data.
CREATE POLICY memberships_read ON memberships FOR SELECT TO cf_app
  USING (tenant_id = app_tenant_id() OR (app_tenant_id() IS NULL AND user_id = app_user_id()));
CREATE POLICY memberships_write ON memberships FOR INSERT TO cf_app WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY memberships_update ON memberships FOR UPDATE TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY memberships_delete ON memberships FOR DELETE TO cf_app USING (tenant_id = app_tenant_id());

CREATE POLICY roles_tenant ON roles FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY role_permissions_tenant ON role_permissions FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- Role links are only ever read for the selected company; permissions are recomputed on every switch.
CREATE POLICY membership_roles_read ON membership_roles FOR SELECT TO cf_app USING (tenant_id = app_tenant_id());
CREATE POLICY membership_roles_write ON membership_roles FOR INSERT TO cf_app WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY membership_roles_delete ON membership_roles FOR DELETE TO cf_app USING (tenant_id = app_tenant_id());
CREATE POLICY invitations_tenant ON invitations FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY auth_invitations ON invitations FOR SELECT TO cf_auth USING (true);

-- users can now see the people in the selected company.
CREATE POLICY users_read ON users FOR SELECT TO cf_app USING (
  id = app_user_id()
  OR id IN (SELECT m.user_id FROM memberships m WHERE m.tenant_id = app_tenant_id()));

GRANT SELECT, INSERT, UPDATE ON tenants TO cf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, roles, role_permissions, membership_roles, invitations TO cf_app;
GRANT SELECT ON permissions TO cf_app;
GRANT SELECT ON invitations TO cf_auth;

-- Look up an invitation by its secret token, before the invitee belongs to the company.
CREATE FUNCTION auth_invitation_lookup(p_token_hash bytea)
RETURNS TABLE (invitation_id uuid, tenant_id uuid, email citext, role_id uuid, expires_at timestamptz,
               accepted_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, tenant_id, email, role_id, expires_at, accepted_at, revoked_at FROM invitations WHERE token_hash = p_token_hash
$$;
ALTER FUNCTION auth_invitation_lookup(bytea) OWNER TO cf_auth;
REVOKE ALL ON FUNCTION auth_invitation_lookup(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_invitation_lookup(bytea) TO cf_app;

-- Permission catalogue (Phase 1). requires_mfa = the action is refused until the user has MFA.
INSERT INTO permissions (key, description, requires_mfa) VALUES
  ('tenant.read',      'View company profile and settings', false),
  ('tenant.update',    'Change company profile and settings', true),
  ('members.read',     'View team members', false),
  ('members.invite',   'Invite people to the company', true),
  ('members.manage',   'Change roles, suspend or remove members', true),
  ('roles.read',       'View roles and permissions', false),
  ('roles.manage',     'Create and edit custom roles', true),
  ('billing.read',     'View plan, limits and usage', false),
  ('billing.manage',   'Change plan and billing details', true),
  ('audit.read',       'View the audit log', true),
  ('files.read',       'Open files shared in the company', false),
  ('files.write',      'Upload files', false),
  ('contacts.read',    'View contacts', false),
  ('contacts.write',   'Create and edit contacts', false),
  ('inbox.read_all',   'See all conversations, not only assigned ones', false),
  ('inbox.reply',      'Reply to customers', false),
  ('reports.read',     'View reports', false);
