-- 0049 AI agent and assistance: fixes from the independent review of W2.2/W2.3.
--
-- M2: the cost of each AI call is reserved before the call and settled after it, so parallel calls cannot overspend
--     the company's budget. A reservation counts at its maximum until settled.
-- M4: explanations record which version of the company's AI settings and of the answer checks applied.
-- H4: a message an AI wrote names the AI result it came from, so the inbox can label it; companies choose whether
--     answers sent to customers carry an "automated reply" note (on by default).

ALTER TABLE ai_usage ADD COLUMN status text NOT NULL DEFAULT 'settled' CHECK (status IN ('reserved', 'settled', 'failed'));
GRANT UPDATE (status, cost_usd, input_tokens, output_tokens, simulated) ON ai_usage TO cf_app;

ALTER TABLE ai_interactions ADD COLUMN settings_version integer;
ALTER TABLE ai_interactions ADD COLUMN checker_version text CHECK (checker_version IS NULL OR length(checker_version) <= 40);
ALTER TABLE ai_interactions ADD CONSTRAINT ai_interactions_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE messages ADD COLUMN ai_interaction_id uuid;
ALTER TABLE messages ADD CONSTRAINT messages_ai_interaction_fk FOREIGN KEY (tenant_id, ai_interaction_id)
  REFERENCES ai_interactions (tenant_id, id) ON DELETE SET NULL (ai_interaction_id);
GRANT INSERT (ai_interaction_id) ON messages TO cf_app;

ALTER TABLE ai_settings ADD COLUMN disclose boolean NOT NULL DEFAULT true;
GRANT UPDATE (disclose) ON ai_settings TO cf_app;

-- The answer checks now include 'unusual_characters', 'injection_suspected' and 'simulated_ai' as reasons; reasons
-- are free text up to 60 characters, so no constraint changes.
