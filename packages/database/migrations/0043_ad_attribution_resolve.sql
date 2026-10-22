-- 0043 Click-to-WhatsApp ad attribution (backlog W1.9, CF-EXT-005, FR-305).
--
-- WhatsApp attaches an ad's details ("referral") to the first message a customer sends after tapping a
-- Click-to-WhatsApp ad. A conversation is credited to the first ad tapped within it: one row per conversation, written
-- when that message is applied; later ad taps in the same conversation never change it (first touch). Outcomes are counted for a fixed window after that first message. Reports show association only;
-- they never claim the ad caused a conversation or a sale.
CREATE TABLE conversation_attributions (
  conversation_id uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL,
  message_id      uuid NOT NULL,
  source_type     text NOT NULL CHECK (source_type IN ('ad', 'post', 'unknown')),
  source_id       text CHECK (source_id IS NULL OR length(source_id) <= 100),
  source_url      text CHECK (source_url IS NULL OR length(source_url) <= 500),
  headline        text CHECK (headline IS NULL OR length(headline) <= 300),
  ctwa_clid       text CHECK (ctwa_clid IS NULL OR length(ctwa_clid) <= 300),
  -- Whether the customer was new to the company: no earlier conversation and no earlier message in this one.
  new_contact     boolean NOT NULL,
  first_message_at timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX conversation_attributions_report ON conversation_attributions (tenant_id, first_message_at);
ALTER TABLE conversation_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_attributions FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_attributions_tenant ON conversation_attributions FOR ALL TO cf_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON conversation_attributions TO cf_app;

-- Conversations already holding an ad's first message (recorded since slice 1) are credited the same way.
ALTER TABLE conversation_attributions NO FORCE ROW LEVEL SECURITY;
INSERT INTO conversation_attributions (conversation_id, tenant_id, contact_id, message_id, source_type, source_id, source_url, headline, ctwa_clid, new_contact, first_message_at)
SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.tenant_id, c.contact_id, m.id,
       CASE WHEN m.referral->>'source_type' IN ('ad', 'post') THEN m.referral->>'source_type' ELSE 'unknown' END,
       left(m.referral->>'source_id', 100), left(m.referral->>'source_url', 500), left(m.referral->>'headline', 300), left(m.referral->>'ctwa_clid', 300),
       NOT EXISTS (SELECT 1 FROM conversations p WHERE p.contact_id = c.contact_id AND p.created_at < c.created_at)
         AND NOT EXISTS (SELECT 1 FROM messages e WHERE e.conversation_id = m.conversation_id AND e.occurred_at < m.occurred_at),
       m.occurred_at
FROM messages m JOIN conversations c ON c.id = m.conversation_id
WHERE m.direction = 'in' AND m.referral IS NOT NULL
ORDER BY m.conversation_id, m.occurred_at, m.id;
ALTER TABLE conversation_attributions FORCE ROW LEVEL SECURITY;

-- Resolving and reopening conversations (FR-201/FR-205): when a conversation was resolved, for resolution metrics and
-- the ad report's outcomes. A resolved conversation stays in history; the customer's next message starts a new one.
ALTER TABLE conversations ADD COLUMN resolved_at timestamptz;
GRANT UPDATE (resolved_at) ON conversations TO cf_app;
