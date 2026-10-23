-- 0058 Indexes for the outcome dashboard (review of W2.9): its period queries read by time within a company.
CREATE INDEX messages_out_created ON messages (tenant_id, created_at) WHERE direction = 'out';
CREATE INDEX conversation_events_kind_created ON conversation_events (tenant_id, kind, created_at);
CREATE INDEX ai_interactions_created ON ai_interactions (tenant_id, created_at);
CREATE INDEX ai_usage_created ON ai_usage (tenant_id, created_at);
CREATE INDEX promises_period ON promises (tenant_id, due_at);
CREATE INDEX conversations_contact_first ON conversations (tenant_id, contact_id, first_inbound_at);
