-- 0023 Fixes from the independent review of messaging slice 1 (3c6d20d).
--  M1  The reply collision check now uses an arrival counter, bumped by every recorded message (inbound or outbound)
--      whatever its provider timestamp. A customer message delivered late, with an older timestamp, still makes an
--      agent's view out of date, so an uninformed reply is refused. last_message_id/at stay for display order only.
--  M3  A sender's idempotency key is unique per sender, not per company: two people choosing the same key no longer
--      collide (previously a server error).

ALTER TABLE conversations ADD COLUMN activity_seq bigint NOT NULL DEFAULT 0;
GRANT UPDATE (activity_seq) ON conversations TO cf_app;

ALTER TABLE messages DROP CONSTRAINT messages_tenant_id_client_message_id_key;
ALTER TABLE messages ADD CONSTRAINT messages_sender_client_message_id_key UNIQUE (tenant_id, sent_by_membership_id, client_message_id);
