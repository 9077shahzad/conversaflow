-- 0062 Message credits: fixes from the independent review of 0061 (29 Oct 2026).
--
-- H1  A message may be charged after its hold was released (a late billable delivery after the stale release or a
--     failed status): one charge per message stays unique; releases and reserves are no longer unique per message,
--     because a released hold can be taken again when the same message is sent again. Their correctness rests on the
--     reservation's state changing under the account lock.
-- H2  Refunds in two steps: the credit is taken out (pending) before the provider is called, outside any lock, and
--     given back with a 'refund_failed' entry if the provider refuses. The worker settles refunds left pending.
-- M5  Entries carry a per-account sequence assigned under the account lock, and the time they were applied, so
--     statements read balances in the order they happened.
-- M4  The worker can find automatic top-ups left pending.

DROP INDEX credit_entries_one_reserve;
DROP INDEX credit_entries_one_settle;
CREATE UNIQUE INDEX credit_entries_one_charge ON credit_entries (message_id) WHERE kind = 'charge';

ALTER TABLE credit_entries DROP CONSTRAINT credit_entries_kind_check;
ALTER TABLE credit_entries ADD CONSTRAINT credit_entries_kind_check
  CHECK (kind IN ('topup', 'reserve', 'release', 'charge', 'refund', 'refund_failed', 'reversal', 'adjustment'));
ALTER TABLE credit_entries ADD CONSTRAINT credit_entries_refund_failed_check
  CHECK (kind <> 'refund_failed' OR (amount_minor > 0 AND reserved_delta = 0 AND refund_id IS NOT NULL));
CREATE UNIQUE INDEX credit_entries_one_refund_failed ON credit_entries (refund_id) WHERE kind = 'refund_failed';

ALTER TABLE credit_accounts ADD COLUMN entry_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE credit_entries ADD COLUMN seq bigint;
-- Existing entries (test data only) are numbered in the order they were written.
ALTER TABLE credit_entries DISABLE TRIGGER credit_entries_append_only;
ALTER TABLE credit_entries NO FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_accounts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_accounts DISABLE TRIGGER credit_accounts_guard;
UPDATE credit_entries e SET seq = n.rn FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn FROM credit_entries) n WHERE n.id = e.id;
UPDATE credit_accounts a SET entry_seq = coalesce((SELECT max(seq) FROM credit_entries e WHERE e.tenant_id = a.tenant_id), 0);
ALTER TABLE credit_accounts ENABLE TRIGGER credit_accounts_guard;
ALTER TABLE credit_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_entries ENABLE TRIGGER credit_entries_append_only;
CREATE UNIQUE INDEX credit_entries_seq ON credit_entries (tenant_id, seq);

CREATE OR REPLACE FUNCTION credit_apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  UPDATE credit_accounts SET balance_minor = balance_minor + NEW.amount_minor, reserved_minor = reserved_minor + NEW.reserved_delta,
                             entry_seq = entry_seq + 1
  WHERE tenant_id = NEW.tenant_id AND status = 'active'
  RETURNING balance_minor, reserved_minor, entry_seq INTO a;
  IF NOT FOUND THEN RAISE EXCEPTION 'no open credit account for this company' USING ERRCODE = 'check_violation'; END IF;
  NEW.balance_after := a.balance_minor;
  NEW.reserved_after := a.reserved_minor;
  NEW.seq := a.entry_seq;
  NEW.created_at := clock_timestamp();   -- after the account lock was taken: the order entries were applied in
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION credit_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.balance_minor IS DISTINCT FROM OLD.balance_minor OR NEW.reserved_minor IS DISTINCT FROM OLD.reserved_minor
      OR NEW.entry_seq IS DISTINCT FROM OLD.entry_seq)
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'balances change only through the credit ledger' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'a credit account cannot change company or currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
GRANT UPDATE (entry_seq) ON credit_accounts TO cf_app, cf_ops;
GRANT UPDATE (price_minor, cost_minor, rate_card_id, market, category, margin_bp, created_at) ON credit_reservations TO cf_app;

-- Worker: refunds and automatic top-ups left pending (a crash or lost answer between the steps).
GRANT SELECT (id, tenant_id, status, created_at) ON credit_refunds TO cf_dispatch;
CREATE POLICY credit_refunds_dispatch_read ON credit_refunds FOR SELECT TO cf_dispatch USING (status = 'pending');
CREATE FUNCTION credit_refunds_pending(p_limit integer) RETURNS TABLE (refund_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.tenant_id FROM credit_refunds r
  WHERE r.status = 'pending' AND r.created_at < now() - interval '5 minutes'
  ORDER BY r.created_at LIMIT least(greatest(p_limit, 1), 500)
$$;
ALTER FUNCTION credit_refunds_pending(integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION credit_refunds_pending(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credit_refunds_pending(integer) TO cf_app;

GRANT SELECT (id, tenant_id, kind, status, created_at) ON credit_topups TO cf_dispatch;
CREATE POLICY credit_topups_dispatch_read ON credit_topups FOR SELECT TO cf_dispatch USING (kind = 'auto' AND status = 'pending');
CREATE FUNCTION credit_auto_topups_stuck(p_limit integer) RETURNS TABLE (topup_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.tenant_id FROM credit_topups t
  WHERE t.kind = 'auto' AND t.status = 'pending' AND t.created_at < now() - interval '15 minutes'
  ORDER BY t.created_at LIMIT least(greatest(p_limit, 1), 500)
$$;
ALTER FUNCTION credit_auto_topups_stuck(integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION credit_auto_topups_stuck(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credit_auto_topups_stuck(integer) TO cf_app;

-- A notice when an automatic top-up was never confirmed.
ALTER TABLE credit_notices DROP CONSTRAINT credit_notices_kind_check;
ALTER TABLE credit_notices ADD CONSTRAINT credit_notices_kind_check
  CHECK (kind IN ('low_balance', 'empty', 'topup_failed', 'auto_topup_failed', 'reversal', 'refund_failed'));

-- Rate cards must be complete (found by the browser checks: an incomplete newest card stopped utility templates).
CREATE OR REPLACE FUNCTION platform_credit_publish_rates(p_token text, p_currency text, p_effective_from timestamptz, p_source text, p_lines jsonb, p_markets jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_id uuid; v_line jsonb; v_market jsonb;
BEGIN
  IF p_effective_from < now() THEN RAISE EXCEPTION 'a rate card cannot start in the past' USING ERRCODE = 'check_violation'; END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 OR jsonb_array_length(p_lines) > 2000 THEN
    RAISE EXCEPTION 'rate lines missing' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO credit_rate_cards (currency, effective_from, source, created_by) VALUES (p_currency, p_effective_from, p_source, v_staff) RETURNING id INTO v_id;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO credit_rate_lines (card_id, market, category, unit_cost_minor)
    VALUES (v_id, v_line->>'market', v_line->>'category', (v_line->>'unitCostMinor')::bigint);
  END LOOP;
  FOR v_market IN SELECT * FROM jsonb_array_elements(coalesce(p_markets, '[]'::jsonb)) LOOP
    INSERT INTO credit_rate_markets (card_id, prefix, market) VALUES (v_id, v_market->>'prefix', v_market->>'market');
  END LOOP;
  -- The newest card in force is the only one used, so it must price every paid category somewhere (review of 0061:
  -- a card without, say, utility lines would stop every utility template with "no rate").
  IF (SELECT count(DISTINCT category) FROM credit_rate_lines WHERE card_id = v_id AND market = 'other'
      AND category IN ('marketing', 'utility', 'authentication')) < 3 THEN
    RAISE EXCEPTION 'a rate card needs marketing, utility and authentication lines for the market "other"' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'credits.rates_published', 'credit_rate_card', v_id::text, jsonb_build_object('currency', p_currency, 'effectiveFrom', p_effective_from, 'source', p_source));
  RETURN v_id;
END $$;
