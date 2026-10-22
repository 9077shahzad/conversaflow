-- 0047 Company AI agent and agent assistance (Wave 2: W2.2 CF-EXT-008 / CF-EXT-021, W2.3 CF-EXT-009; FR-501–507).
--
-- Off by default. Each company chooses whether the AI may answer customers by itself or only draft for a person,
-- writes its own knowledge articles (the only source of facts besides tools that read company settings), and sets a
-- monthly budget. Every AI result is recorded with its explanation and cost. Translations keep the original message.

CREATE TABLE ai_settings (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled            boolean NOT NULL DEFAULT false,
  mode               text NOT NULL DEFAULT 'suggest' CHECK (mode IN ('suggest', 'answer')),
  instructions       text NOT NULL DEFAULT '' CHECK (length(instructions) <= 2000),
  monthly_budget_usd numeric(10, 2) NOT NULL DEFAULT 20 CHECK (monthly_budget_usd BETWEEN 0 AND 10000),
  version            int NOT NULL DEFAULT 1,
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_articles (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  body        text NOT NULL CHECK (length(body) BETWEEN 10 AND 8000),
  language    text NOT NULL CHECK (language IN ('en', 'ar')),
  published   boolean NOT NULL DEFAULT true,
  -- Search terms, worked out by the application when the article is saved (lower case, Arabic diacritics removed,
  -- common Arabic prefixes such as "ال" also stripped). Independent of the database's locale, so Arabic matches too.
  terms       text[] NOT NULL DEFAULT '{}' CHECK (cardinality(terms) <= 4000),
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX knowledge_articles_terms ON knowledge_articles USING gin (terms);

CREATE TABLE ai_usage (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task            text NOT NULL CHECK (task IN ('agent_reply', 'translate', 'summarise', 'suggest_replies')),
  input_tokens    int NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens   int NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd        numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  provider        text NOT NULL CHECK (provider IN ('simulated', 'anthropic')),
  simulated       boolean NOT NULL,
  conversation_id uuid,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_month ON ai_usage (tenant_id, created_at);

-- Explanations (CF-EXT-021): what the AI was given, what it produced, which checks failed and what was decided.
CREATE TABLE ai_interactions (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id     uuid,
  run_id              uuid,
  task                text NOT NULL CHECK (task IN ('agent_reply', 'translate', 'summarise', 'suggest_replies')),
  decision            text NOT NULL CHECK (decision IN ('answer', 'suggestion', 'human_needed')),
  reason              text CHECK (reason IS NULL OR length(reason) <= 60),
  reasons             jsonb NOT NULL DEFAULT '[]'::jsonb,
  text                text CHECK (text IS NULL OR length(text) <= 8000),
  -- An answer the checks withheld, kept for review only; never shown to a customer.
  rejected_text       text CHECK (rejected_text IS NULL OR length(rejected_text) <= 8000),
  citations           jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools               jsonb NOT NULL DEFAULT '[]'::jsonb,
  injection_suspected boolean NOT NULL DEFAULT false,
  provider            text NOT NULL,
  model               text,
  simulated           boolean NOT NULL,
  input_tokens        int NOT NULL DEFAULT 0,
  output_tokens       int NOT NULL DEFAULT 0,
  cost_usd            numeric(12, 6) NOT NULL DEFAULT 0,
  error_code          text CHECK (error_code IS NULL OR length(error_code) <= 60),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs (tenant_id, id) ON DELETE SET NULL (run_id)
);
CREATE INDEX ai_interactions_conversation ON ai_interactions (conversation_id, created_at);

CREATE TABLE message_translations (
  tenant_id  uuid NOT NULL,
  message_id uuid NOT NULL,
  language   text NOT NULL CHECK (language IN ('en', 'ar')),
  text       text NOT NULL CHECK (length(text) <= 8000),
  provider   text NOT NULL,
  simulated  boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, language),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_articles ENABLE ROW LEVEL SECURITY; ALTER TABLE knowledge_articles FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_interactions ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_interactions FORCE ROW LEVEL SECURITY;
ALTER TABLE message_translations ENABLE ROW LEVEL SECURITY; ALTER TABLE message_translations FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_settings_tenant ON ai_settings FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY knowledge_articles_tenant ON knowledge_articles FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY ai_usage_tenant ON ai_usage FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY ai_interactions_tenant ON ai_interactions FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY message_translations_tenant ON message_translations FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON ai_settings TO cf_app;
GRANT UPDATE (enabled, mode, instructions, monthly_budget_usd, version, updated_by, updated_at) ON ai_settings TO cf_app;
GRANT SELECT, INSERT, DELETE ON knowledge_articles TO cf_app;
GRANT UPDATE (title, body, language, published, terms, updated_by, updated_at) ON knowledge_articles TO cf_app;
GRANT SELECT, INSERT ON ai_usage TO cf_app;
GRANT SELECT, INSERT ON ai_interactions TO cf_app;
GRANT SELECT, INSERT ON message_translations TO cf_app;

-- The automation step "AI reply" and its hand-over event.
ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check
  CHECK (kind IN ('assigned', 'unassigned', 'takeover', 'status_changed', 'opted_out', 'opted_in', 'paused', 'resumed', 'retried',
                  'sla_met', 'sla_missed', 'tagged', 'untagged', 'auto_assigned', 'handed_off', 'ai_handoff'));

-- Permissions: ai.manage (owner, admin) for settings; knowledge.manage (owner, admin, supervisor) for articles.
INSERT INTO permissions (key, description, requires_mfa) VALUES
  ('ai.manage', 'Turn AI features on or off, choose how they may answer and set the budget', true),
  ('knowledge.manage', 'Write the company''s knowledge articles used by the AI', false);
INSERT INTO system_role_grants (role_key, permission_key, added_in) VALUES
  ('owner', 'ai.manage', '0047'), ('admin', 'ai.manage', '0047'),
  ('owner', 'knowledge.manage', '0047'), ('admin', 'knowledge.manage', '0047'), ('supervisor', 'knowledge.manage', '0047');
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission_key)
  SELECT r.tenant_id, r.id, g.permission_key
  FROM roles r JOIN system_role_grants g ON g.role_key = r.key
  WHERE r.is_system AND g.added_in = '0047'
  ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
