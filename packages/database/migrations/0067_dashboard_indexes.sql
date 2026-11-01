-- 0067 Indexes for the company dashboard (review of the dashboards, finding 1): its period queries read every message
-- of one company by time (both directions), and look up each conversation's customer number by contact.
CREATE INDEX messages_tenant_created ON messages (tenant_id, created_at, id);
CREATE INDEX contact_identifiers_contact ON contact_identifiers (tenant_id, contact_id, kind, created_at);
