-- 0025 Retry rules and failure kinds (owner decisions of 21 Oct 2026).
--  1. A person who may currently reply to a conversation may retry a colleague's failed message. Both people are
--     recorded: the original author (original_author_membership_id) and the person retrying (sent_by_membership_id).
--  2. A retry copy cannot be used to get round the retry limit. Every message in a retry chain points to the first
--     message (retry_root) and carries its position (retry_number). Both are derived by the database from the message
--     being retried, never taken from the request, and the chain length is capped by a constraint.
--  3. A failed message is always a CONFIRMED failure: we know the customer did not receive it. failure_kind says how
--     we know. A send whose outcome is unknown is never 'failed'; it is 'uncertain' (see sender.ts).

-- Failure kinds ------------------------------------------------------------------------------------------------------
--   blocked           stopped by our own checks before anything was sent (opt-out, pause, window, assignment ...)
--   rejected          the provider refused the request
--   exhausted         the provider repeatedly answered "not accepted" (e.g. rate limit) until the attempt limit
--   provider_reported the provider accepted it and later reported that delivery failed (status webhook)
ALTER TABLE messages ADD COLUMN failure_kind text
  CHECK (failure_kind IS NULL OR failure_kind IN ('blocked', 'rejected', 'exhausted', 'provider_reported'));
UPDATE messages SET failure_kind = CASE
    WHEN error_code LIKE 'retries_exhausted:%' THEN 'exhausted'
    WHEN error_code IN ('contact_opted_out', 'replies_paused', 'channel_disabled', 'template_required', 'no_whatsapp_identifier') THEN 'blocked'
    ELSE 'rejected' END
  WHERE status = 'failed';
ALTER TABLE messages ADD CONSTRAINT messages_failed_has_kind CHECK ((status = 'failed') = (failure_kind IS NOT NULL));
GRANT UPDATE (failure_kind) ON messages TO cf_app;

-- Retry lineage --------------------------------------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN original_author_membership_id uuid;
ALTER TABLE messages ADD COLUMN retry_root uuid;
-- 0 for an original message; 1 for its retry. The limit is one manual retry per original message, across the whole
-- chain: a retry copy that fails cannot itself be retried.
ALTER TABLE messages ADD COLUMN retry_number smallint NOT NULL DEFAULT 0 CHECK (retry_number BETWEEN 0 AND 1);
ALTER TABLE messages ADD CONSTRAINT messages_original_author_fk
  FOREIGN KEY (tenant_id, original_author_membership_id) REFERENCES memberships (tenant_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_retry_root_fk FOREIGN KEY (tenant_id, retry_root) REFERENCES messages (tenant_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_retry_lineage_complete
  CHECK ((retry_of IS NULL) = (retry_root IS NULL) AND (retry_of IS NULL) = (retry_number = 0));
CREATE UNIQUE INDEX messages_one_retry_per_position ON messages (tenant_id, retry_root, retry_number) WHERE retry_root IS NOT NULL;
UPDATE messages SET original_author_membership_id = sent_by_membership_id WHERE direction = 'out';
UPDATE messages m SET retry_root = m.retry_of, retry_number = 1 WHERE m.retry_of IS NOT NULL;
UPDATE messages m SET original_author_membership_id = o.sent_by_membership_id FROM messages o WHERE m.retry_of = o.id;

-- Derives the lineage from the message being retried, so a request cannot choose its own position in the chain.
-- Runs as the inserting role (cf_app) under row-level security: the original must be visible in the same company.
CREATE FUNCTION messages_retry_lineage() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  parent record;
BEGIN
  IF NEW.direction <> 'out' THEN
    NEW.retry_root := NULL; NEW.retry_number := 0; NEW.original_author_membership_id := NULL;
    IF NEW.retry_of IS NOT NULL THEN RAISE EXCEPTION 'only outbound messages can be retries' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.retry_of IS NULL THEN
    NEW.retry_root := NULL; NEW.retry_number := 0; NEW.original_author_membership_id := NEW.sent_by_membership_id;
    RETURN NEW;
  END IF;
  SELECT id, tenant_id, conversation_id, direction, status, retry_root, retry_number, original_author_membership_id
    INTO parent FROM messages WHERE id = NEW.retry_of AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR parent.direction <> 'out' OR parent.conversation_id <> NEW.conversation_id THEN
    RAISE EXCEPTION 'the message being retried was not found in this conversation' USING ERRCODE = '23503';
  END IF;
  IF parent.status NOT IN ('failed', 'uncertain') THEN
    RAISE EXCEPTION 'only a failed or uncertain message can be retried' USING ERRCODE = '23514';
  END IF;
  NEW.retry_root := coalesce(parent.retry_root, parent.id);
  NEW.retry_number := parent.retry_number + 1;   -- the CHECK above refuses anything past the limit
  NEW.original_author_membership_id := parent.original_author_membership_id;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_retry_lineage BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_retry_lineage();
-- Lineage is fixed once written.
REVOKE UPDATE (retry_of, retry_root, retry_number, original_author_membership_id) ON messages FROM cf_app;
