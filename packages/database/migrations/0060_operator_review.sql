-- 0060 Conversa Operator slice 1: fixes from the independent review.
--
-- * A quote message is marked with its quote, so the sender checks again, at the moment of sending, that the module is
--   on, not paused, and the quote is still the open version (the pause holds it; a closed quote blocks it).
-- * Once set, approval and sending details of a quote never change, and a used or revoked link stays so.
ALTER TABLE messages ADD COLUMN op_quote_id uuid;
ALTER TABLE messages ADD CONSTRAINT messages_op_quote_fk FOREIGN KEY (tenant_id, op_quote_id) REFERENCES op_quotes (tenant_id, id);
GRANT INSERT (op_quote_id) ON messages TO cf_app;

CREATE OR REPLACE FUNCTION op_quotes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.rate_card_id IS DISTINCT FROM OLD.rate_card_id OR NEW.request IS DISTINCT FROM OLD.request OR NEW.priced IS DISTINCT FROM OLD.priced
     OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
     OR NEW.deposit_minor IS DISTINCT FROM OLD.deposit_minor OR NEW.scope_en IS DISTINCT FROM OLD.scope_en OR NEW.scope_ar IS DISTINCT FROM OLD.scope_ar
     OR NEW.terms_version IS DISTINCT FROM OLD.terms_version OR NEW.terms_en IS DISTINCT FROM OLD.terms_en OR NEW.terms_ar IS DISTINCT FROM OLD.terms_ar
     OR (NEW.valid_until IS DISTINCT FROM OLD.valid_until AND NOT (OLD.status IN ('draft', 'approved') AND NEW.status = 'sent'))
     OR NEW.needs_approval IS DISTINCT FROM OLD.needs_approval OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR (OLD.approved_at IS NOT NULL AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by))
     OR (OLD.sent_at IS NOT NULL AND (NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.sent_message_id IS DISTINCT FROM OLD.sent_message_id)) THEN
    RAISE EXCEPTION 'a quote version cannot be rewritten; make a new version' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('accepted', 'expired', 'superseded', 'withdrawn') THEN
    RAISE EXCEPTION 'a closed quote cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'approved', 'sent', 'withdrawn', 'superseded'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'withdrawn', 'superseded'))
    OR (OLD.status = 'approved' AND NEW.status IN ('sent', 'withdrawn', 'superseded'))
    OR (OLD.status = 'sent' AND NEW.status IN ('accepted', 'expired', 'superseded', 'withdrawn'))) THEN
    RAISE EXCEPTION 'a quote cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION op_quote_links_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at) OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.quote_id IS DISTINCT FROM OLD.quote_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'a used or revoked quote link stays so' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER op_quote_links_guard BEFORE UPDATE ON op_quote_links FOR EACH ROW EXECUTE FUNCTION op_quote_links_guard();
