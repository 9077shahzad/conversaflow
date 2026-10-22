-- 0039 Automatic assignment (BRD v1.2 Wave 1, CF-EXT-002 / backlog W1.6).
--
-- When a customer starts a new conversation, it can be given to a team member automatically: in turn (round robin)
-- or to whoever has the fewest open conversations (least busy). Only members a supervisor has put on the assignment
-- list are chosen, and only while they are active and allowed to reply. Optionally only during business hours;
-- outside them, new conversations stay unassigned for the team to pick up. Off by default.

ALTER TABLE tenant_settings ADD COLUMN assignment_mode text NOT NULL DEFAULT 'off' CHECK (assignment_mode IN ('off', 'round_robin', 'least_busy'));
ALTER TABLE tenant_settings ADD COLUMN assignment_hours_only boolean NOT NULL DEFAULT false;
-- The member who received the last automatic assignment, so round robin continues from the next one.
ALTER TABLE tenant_settings ADD COLUMN assignment_last_membership uuid;
GRANT UPDATE (assignment_mode, assignment_hours_only, assignment_last_membership) ON tenant_settings TO cf_app;

CREATE TABLE assignment_members (
  tenant_id      uuid NOT NULL,
  membership_id  uuid NOT NULL,
  added_by       uuid,
  added_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, membership_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, added_by) REFERENCES memberships (tenant_id, id)
);
ALTER TABLE assignment_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_members FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_members_tenant ON assignment_members FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, DELETE ON assignment_members TO cf_app;
