-- 0061 Prepaid WhatsApp message credits (owner decision of 29 Oct 2026).
--
-- Companies onboarded through the Solution Partner arrangement do not pay Meta themselves: the partner pays Meta and
-- invoices Meronatic, and ConversaFlow sells message credits to each company as a prepaid balance, with a margin.
-- Companies without a credit account keep paying Meta directly, exactly as before: nothing here changes them.
-- Message credits are kept apart from subscription charges (own tables, own ledger, own receipts).
--
-- The ledger is the truth: every change of a balance is one append-only entry, and a trigger applies it to the
-- account, so balance = sum(amount) and reserved = sum(reserved_delta) at all times. Amounts are integers in the
-- currency's minor unit.
--   topup        +amount            (a verified successful payment; once per top-up)
--   reserve      reserved +x        (a paid message about to be sent; once per message)
--   release      reserved -x        (it was not sent, failed, or was free after all)
--   charge       -price, reserved -x(delivered and billable; once per message)
--   refund       -amount            (money returned to the company from its unused balance)
--   reversal     -amount            (a payment taken back by the bank: dispute lost; may go below zero)
--   adjustment   +/-amount          (platform staff, with a note)

-- --- Platform: rates and margins ------------------------------------------------------------------------------------
CREATE TABLE credit_settings (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  default_margin_bp   integer NOT NULL DEFAULT 2000 CHECK (default_margin_bp BETWEEN 0 AND 20000),
  reservation_hours   integer NOT NULL DEFAULT 72 CHECK (reservation_hours BETWEEN 1 AND 720),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid
);
INSERT INTO credit_settings DEFAULT VALUES;

-- A rate card is Meta's price list (through the partner) for one currency from a date. It never changes once it
-- exists; a change is a new card with a later effective date. Lines are per market and category; markets are found
-- from the recipient's number by the longest matching calling-code prefix, or 'other'.
CREATE TABLE credit_rate_cards (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from  timestamptz NOT NULL,
  source          text NOT NULL CHECK (length(source) BETWEEN 3 AND 300),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency, effective_from)
);
CREATE TABLE credit_rate_lines (
  card_id          uuid NOT NULL REFERENCES credit_rate_cards(id),
  market           text NOT NULL CHECK (market ~ '^[a-z_]{2,40}$'),
  category         text NOT NULL CHECK (category IN ('marketing', 'utility', 'authentication', 'service')),
  unit_cost_minor  bigint NOT NULL CHECK (unit_cost_minor BETWEEN 0 AND 1000000),
  PRIMARY KEY (card_id, market, category)
);
CREATE TABLE credit_rate_markets (
  card_id  uuid NOT NULL REFERENCES credit_rate_cards(id),
  prefix   text NOT NULL CHECK (prefix ~ '^[0-9]{1,6}$'),
  market   text NOT NULL CHECK (market ~ '^[a-z_]{2,40}$'),
  PRIMARY KEY (card_id, prefix)
);
CREATE FUNCTION credit_rates_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'rate cards never change; publish a new card with a later effective date' USING ERRCODE = 'check_violation'; END $$;
CREATE TRIGGER credit_rate_cards_frozen BEFORE UPDATE OR DELETE ON credit_rate_cards FOR EACH ROW EXECUTE FUNCTION credit_rates_frozen();
CREATE TRIGGER credit_rate_lines_frozen BEFORE UPDATE OR DELETE ON credit_rate_lines FOR EACH ROW EXECUTE FUNCTION credit_rates_frozen();
CREATE TRIGGER credit_rate_markets_frozen BEFORE UPDATE OR DELETE ON credit_rate_markets FOR EACH ROW EXECUTE FUNCTION credit_rates_frozen();

-- --- Companies: accounts, ledger, reservations ------------------------------------------------------------------
CREATE TABLE credit_accounts (
  tenant_id               uuid PRIMARY KEY REFERENCES tenants(id),
  currency                text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_minor           bigint NOT NULL DEFAULT 0,
  reserved_minor          bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  margin_bp               integer CHECK (margin_bp IS NULL OR margin_bp BETWEEN 0 AND 20000),
  low_threshold_minor     bigint NOT NULL DEFAULT 0 CHECK (low_threshold_minor >= 0),
  low_alerted_at          timestamptz,
  -- Automatic top-up: off unless a person with billing permission explicitly turns it on and agrees to the wording.
  auto_enabled            boolean NOT NULL DEFAULT false,
  auto_threshold_minor    bigint CHECK (auto_threshold_minor IS NULL OR auto_threshold_minor >= 0),
  auto_amount_minor       bigint CHECK (auto_amount_minor IS NULL OR auto_amount_minor > 0),
  auto_daily_limit_minor  bigint CHECK (auto_daily_limit_minor IS NULL OR auto_daily_limit_minor > 0),
  auto_method_id          uuid,
  auto_consent_at         timestamptz,
  auto_consent_by         uuid,
  auto_consent_text       text,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  opened_at               timestamptz NOT NULL DEFAULT now(),
  opened_by               uuid,
  CHECK (NOT auto_enabled OR (auto_threshold_minor IS NOT NULL AND auto_amount_minor IS NOT NULL AND auto_daily_limit_minor IS NOT NULL
                              AND auto_method_id IS NOT NULL AND auto_consent_at IS NOT NULL AND auto_consent_by IS NOT NULL AND auto_consent_text IS NOT NULL))
);

CREATE TABLE credit_topups (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  currency        text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('manual', 'auto')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  provider        text NOT NULL CHECK (provider ~ '^[a-z_]{2,30}$'),
  provider_ref    text CHECK (provider_ref IS NULL OR length(provider_ref) <= 200),
  failure_reason  text CHECK (failure_reason IS NULL OR length(failure_reason) <= 200),
  refunded_minor  bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  reversed        boolean NOT NULL DEFAULT false,
  receipt_no      text UNIQUE,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_ref),
  CHECK (refunded_minor <= amount_minor),
  CHECK ((status = 'succeeded') = (receipt_no IS NOT NULL))
);
CREATE INDEX credit_topups_tenant ON credit_topups (tenant_id, created_at DESC);
CREATE UNIQUE INDEX credit_topups_one_auto_pending ON credit_topups (tenant_id) WHERE kind = 'auto' AND status = 'pending';

CREATE TABLE credit_refunds (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  topup_id        uuid NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_ref    text,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  credit_note_no  text UNIQUE,
  requested_by    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, topup_id) REFERENCES credit_topups (tenant_id, id),
  CHECK ((status = 'succeeded') = (credit_note_no IS NOT NULL))
);

CREATE TABLE credit_reservations (
  message_id      uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  rate_card_id    uuid NOT NULL REFERENCES credit_rate_cards(id),
  market          text NOT NULL,
  category        text NOT NULL,
  cost_minor      bigint NOT NULL CHECK (cost_minor >= 0),
  price_minor     bigint NOT NULL CHECK (price_minor >= 0),
  margin_bp       integer NOT NULL,
  state           text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'charged', 'released')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz,
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id)
);
CREATE INDEX credit_reservations_held ON credit_reservations (created_at) WHERE state = 'held';

CREATE TABLE credit_entries (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id        uuid NOT NULL REFERENCES credit_accounts(tenant_id),
  kind             text NOT NULL CHECK (kind IN ('topup', 'reserve', 'release', 'charge', 'refund', 'reversal', 'adjustment')),
  amount_minor     bigint NOT NULL,
  reserved_delta   bigint NOT NULL DEFAULT 0,
  balance_after    bigint,
  reserved_after   bigint,
  message_id       uuid,
  topup_id         uuid,
  refund_id        uuid,
  rate_card_id     uuid REFERENCES credit_rate_cards(id),
  market           text,
  category         text,
  cost_minor       bigint,
  margin_bp        integer,
  note             text CHECK (note IS NULL OR length(note) <= 300),
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'topup' OR (amount_minor > 0 AND reserved_delta = 0 AND topup_id IS NOT NULL)),
  CHECK (kind <> 'reserve' OR (amount_minor = 0 AND reserved_delta > 0 AND message_id IS NOT NULL)),
  CHECK (kind <> 'release' OR (amount_minor = 0 AND reserved_delta < 0 AND message_id IS NOT NULL)),
  CHECK (kind <> 'charge' OR (amount_minor <= 0 AND reserved_delta <= 0 AND message_id IS NOT NULL AND rate_card_id IS NOT NULL)),
  CHECK (kind <> 'refund' OR (amount_minor < 0 AND reserved_delta = 0 AND refund_id IS NOT NULL)),
  CHECK (kind <> 'reversal' OR (amount_minor < 0 AND reserved_delta = 0 AND topup_id IS NOT NULL)),
  CHECK (kind <> 'adjustment' OR (amount_minor <> 0 AND reserved_delta = 0 AND note IS NOT NULL AND created_by IS NOT NULL))
);
CREATE INDEX credit_entries_tenant ON credit_entries (tenant_id, created_at DESC, id DESC);
-- Each event moves money once, however often it is reported.
CREATE UNIQUE INDEX credit_entries_one_topup ON credit_entries (topup_id) WHERE kind = 'topup';
CREATE UNIQUE INDEX credit_entries_one_reversal ON credit_entries (topup_id) WHERE kind = 'reversal';
CREATE UNIQUE INDEX credit_entries_one_reserve ON credit_entries (message_id) WHERE kind = 'reserve';
CREATE UNIQUE INDEX credit_entries_one_settle ON credit_entries (message_id) WHERE kind IN ('release', 'charge');
CREATE UNIQUE INDEX credit_entries_one_refund ON credit_entries (refund_id) WHERE kind = 'refund';

-- Applying an entry to its account, in the same statement, under the account's row lock.
CREATE FUNCTION credit_apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  UPDATE credit_accounts SET balance_minor = balance_minor + NEW.amount_minor, reserved_minor = reserved_minor + NEW.reserved_delta
  WHERE tenant_id = NEW.tenant_id AND status = 'active'
  RETURNING balance_minor, reserved_minor INTO a;
  IF NOT FOUND THEN RAISE EXCEPTION 'no open credit account for this company' USING ERRCODE = 'check_violation'; END IF;
  NEW.balance_after := a.balance_minor;
  NEW.reserved_after := a.reserved_minor;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_entries_apply BEFORE INSERT ON credit_entries FOR EACH ROW EXECUTE FUNCTION credit_apply_entry();
CREATE FUNCTION credit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'the credit ledger is append-only' USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER credit_entries_append_only BEFORE UPDATE OR DELETE ON credit_entries FOR EACH ROW EXECUTE FUNCTION credit_append_only();
-- Balances move only through the ledger: the only update allowed to change them is the one made by the trigger above
-- (trigger depth 2), which a session cannot fake the way it could a setting.
CREATE FUNCTION credit_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.balance_minor IS DISTINCT FROM OLD.balance_minor OR NEW.reserved_minor IS DISTINCT FROM OLD.reserved_minor)
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'balances change only through the credit ledger' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'a credit account cannot change company or currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_accounts_guard BEFORE UPDATE ON credit_accounts FOR EACH ROW EXECUTE FUNCTION credit_accounts_guard();

-- Payment provider events, recorded once each (verified signature), whatever the provider retries.
CREATE TABLE credit_payment_events (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  provider      text NOT NULL,
  event_id      text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  type          text NOT NULL CHECK (length(type) <= 60),
  provider_ref  text,
  amount_minor  bigint,
  currency      text,
  outcome       text NOT NULL CHECK (length(outcome) <= 60),
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
CREATE TABLE credit_payment_methods (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  provider      text NOT NULL,
  provider_ref  text NOT NULL CHECK (length(provider_ref) <= 200),
  label         text NOT NULL CHECK (length(label) <= 60),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  UNIQUE (tenant_id, id)
);
ALTER TABLE credit_accounts ADD CONSTRAINT credit_accounts_method_fk FOREIGN KEY (tenant_id, auto_method_id) REFERENCES credit_payment_methods (tenant_id, id);

CREATE TABLE credit_notices (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  kind        text NOT NULL CHECK (kind IN ('low_balance', 'empty', 'topup_failed', 'auto_topup_failed', 'reversal')),
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX credit_notices_tenant ON credit_notices (tenant_id, created_at DESC);

-- Monthly reconciliation: what the partner says Meronatic owes for each company, beside what the ledger charged.
CREATE TABLE credit_partner_costs (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  month          date NOT NULL CHECK (extract(day FROM month) = 1),
  currency       text NOT NULL,
  cost_minor     bigint NOT NULL CHECK (cost_minor >= 0),
  message_count  integer CHECK (message_count IS NULL OR message_count >= 0),
  reference      text NOT NULL CHECK (length(reference) BETWEEN 2 AND 200),
  recorded_by    uuid,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, month, currency)
);

CREATE SEQUENCE credit_receipt_seq;
CREATE SEQUENCE credit_note_seq;

-- --- Access ---------------------------------------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['credit_accounts', 'credit_topups', 'credit_refunds', 'credit_reservations', 'credit_entries',
                           'credit_payment_events', 'credit_payment_methods', 'credit_notices', 'credit_partner_costs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['credit_accounts', 'credit_topups', 'credit_refunds', 'credit_reservations', 'credit_entries',
                           'credit_payment_events', 'credit_payment_methods', 'credit_notices'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_tenant', t);
  END LOOP;
END $$;
-- The company sees the partner's cost for its own account only in its statement (read only).
CREATE POLICY credit_partner_costs_tenant ON credit_partner_costs FOR SELECT TO cf_app USING (tenant_id = app_tenant_id());

GRANT SELECT ON credit_settings, credit_rate_cards, credit_rate_lines, credit_rate_markets TO cf_app;
GRANT SELECT ON credit_accounts TO cf_app;
GRANT UPDATE (balance_minor, reserved_minor, low_threshold_minor, low_alerted_at, auto_enabled, auto_threshold_minor, auto_amount_minor,
              auto_daily_limit_minor, auto_method_id, auto_consent_at, auto_consent_by, auto_consent_text) ON credit_accounts TO cf_app;
GRANT SELECT, INSERT ON credit_entries, credit_topups, credit_refunds, credit_reservations, credit_payment_events, credit_payment_methods, credit_notices TO cf_app;
GRANT UPDATE (status, provider_ref, failure_reason, refunded_minor, reversed, receipt_no, settled_at) ON credit_topups TO cf_app;
GRANT UPDATE (status, provider_ref, credit_note_no, settled_at) ON credit_refunds TO cf_app;
GRANT UPDATE (state, settled_at) ON credit_reservations TO cf_app;
GRANT UPDATE (removed_at) ON credit_payment_methods TO cf_app;
GRANT UPDATE (read_at) ON credit_notices TO cf_app;
GRANT UPDATE (outcome) ON credit_payment_events TO cf_app;
GRANT SELECT ON credit_partner_costs TO cf_app;
GRANT USAGE ON SEQUENCE credit_receipt_seq, credit_note_seq TO cf_app;

-- The worker releases reservations whose message never became billable, and runs automatic top-ups, across companies.
GRANT SELECT (message_id, tenant_id, state, created_at) ON credit_reservations TO cf_dispatch;
CREATE POLICY credit_reservations_dispatch_read ON credit_reservations FOR SELECT TO cf_dispatch USING (state = 'held');
CREATE FUNCTION credit_reservations_stale(p_limit integer) RETURNS TABLE (message_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.message_id, r.tenant_id FROM credit_reservations r
  WHERE r.state = 'held' AND r.created_at < now() - make_interval(hours => (SELECT reservation_hours FROM credit_settings))
  ORDER BY r.created_at LIMIT least(greatest(p_limit, 1), 500)
$$;
GRANT SELECT (reservation_hours) ON credit_settings TO cf_dispatch;
ALTER FUNCTION credit_reservations_stale(integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION credit_reservations_stale(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credit_reservations_stale(integer) TO cf_app;

GRANT SELECT (tenant_id, status, auto_enabled, auto_threshold_minor, balance_minor, reserved_minor) ON credit_accounts TO cf_dispatch;
CREATE POLICY credit_accounts_dispatch_read ON credit_accounts FOR SELECT TO cf_dispatch USING (status = 'active' AND auto_enabled);
CREATE FUNCTION credit_auto_topup_due(p_limit integer) RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.tenant_id FROM credit_accounts a
  WHERE a.status = 'active' AND a.auto_enabled AND a.balance_minor - a.reserved_minor < a.auto_threshold_minor
  ORDER BY a.tenant_id LIMIT least(greatest(p_limit, 1), 500)
$$;
ALTER FUNCTION credit_auto_topup_due(integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION credit_auto_topup_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credit_auto_topup_due(integer) TO cf_app;

-- --- Platform console: opening accounts, rates, margins, adjustments, partner costs, statement ----------------------
-- Token-bound like every console function: the database re-derives the staff member from a live, verified session.
GRANT SELECT, INSERT ON credit_rate_cards, credit_rate_lines, credit_rate_markets TO cf_ops;
GRANT SELECT, UPDATE (default_margin_bp, reservation_hours, updated_at, updated_by) ON credit_settings TO cf_ops;
GRANT SELECT, INSERT ON credit_accounts TO cf_ops;
GRANT UPDATE (margin_bp, low_threshold_minor) ON credit_accounts TO cf_ops;
GRANT SELECT, INSERT ON credit_entries, credit_partner_costs TO cf_ops;
GRANT UPDATE (cost_minor, message_count, reference, recorded_by, recorded_at) ON credit_partner_costs TO cf_ops;
GRANT UPDATE (balance_minor, reserved_minor) ON credit_accounts TO cf_ops;
CREATE POLICY credit_accounts_ops ON credit_accounts FOR ALL TO cf_ops USING (true) WITH CHECK (true);
CREATE POLICY credit_entries_ops ON credit_entries FOR ALL TO cf_ops USING (true) WITH CHECK (kind = 'adjustment');
CREATE POLICY credit_partner_costs_ops ON credit_partner_costs FOR ALL TO cf_ops USING (true) WITH CHECK (true);

CREATE FUNCTION platform_credit_open_account(p_token text, p_tenant uuid, p_currency text, p_low_threshold bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner');
BEGIN
  IF p_currency NOT IN ('SAR', 'AED', 'USD') THEN RAISE EXCEPTION 'unsupported currency' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO credit_accounts (tenant_id, currency, low_threshold_minor, opened_by) VALUES (p_tenant, p_currency, greatest(coalesce(p_low_threshold, 0), 0), v_staff);
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'credits.account_opened', 'tenant', p_tenant::text, jsonb_build_object('currency', p_currency));
END $$;

CREATE FUNCTION platform_credit_publish_rates(p_token text, p_currency text, p_effective_from timestamptz, p_source text, p_lines jsonb, p_markets jsonb) RETURNS uuid
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
  IF NOT EXISTS (SELECT 1 FROM credit_rate_lines WHERE card_id = v_id AND market = 'other') THEN
    RAISE EXCEPTION 'a rate card needs lines for the market "other"' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'credits.rates_published', 'credit_rate_card', v_id::text, jsonb_build_object('currency', p_currency, 'effectiveFrom', p_effective_from, 'source', p_source));
  RETURN v_id;
END $$;

CREATE FUNCTION platform_credit_set_margin(p_token text, p_tenant uuid, p_margin_bp integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner');
BEGIN
  IF p_margin_bp IS NOT NULL AND (p_margin_bp < 0 OR p_margin_bp > 20000) THEN RAISE EXCEPTION 'margin out of range' USING ERRCODE = 'check_violation'; END IF;
  IF p_tenant IS NULL THEN
    UPDATE credit_settings SET default_margin_bp = coalesce(p_margin_bp, default_margin_bp), updated_at = now(), updated_by = v_staff;
  ELSE
    UPDATE credit_accounts SET margin_bp = p_margin_bp WHERE tenant_id = p_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'no credit account for this company' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'credits.margin_set', CASE WHEN p_tenant IS NULL THEN 'platform' ELSE 'tenant' END, coalesce(p_tenant::text, 'default'), jsonb_build_object('marginBp', p_margin_bp));
END $$;

CREATE FUNCTION platform_credit_adjust(p_token text, p_tenant uuid, p_amount bigint, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_id uuid;
BEGIN
  IF p_amount = 0 OR abs(p_amount) > 100000000 THEN RAISE EXCEPTION 'adjustment out of range' USING ERRCODE = 'check_violation'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 5 THEN RAISE EXCEPTION 'say why' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO credit_entries (tenant_id, kind, amount_minor, note, created_by) VALUES (p_tenant, 'adjustment', p_amount, left(btrim(p_note), 300), v_staff) RETURNING id INTO v_id;
  INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, metadata, hash)
  VALUES (p_tenant, v_staff, 'credits.adjusted', 'credit_entry', v_id, jsonb_build_object('amountMinor', p_amount, 'note', left(btrim(p_note), 300)), ''::bytea);
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'credits.adjusted', 'tenant', p_tenant::text, jsonb_build_object('amountMinor', p_amount));
  RETURN v_id;
END $$;

CREATE FUNCTION platform_credit_record_partner_cost(p_token text, p_tenant uuid, p_month date, p_currency text, p_cost bigint, p_count integer, p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner');
BEGIN
  INSERT INTO credit_partner_costs (tenant_id, month, currency, cost_minor, message_count, reference, recorded_by)
  VALUES (p_tenant, date_trunc('month', p_month)::date, p_currency, p_cost, p_count, p_reference, v_staff)
  ON CONFLICT (tenant_id, month, currency) DO UPDATE SET cost_minor = EXCLUDED.cost_minor, message_count = EXCLUDED.message_count,
    reference = EXCLUDED.reference, recorded_by = EXCLUDED.recorded_by, recorded_at = now();
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'credits.partner_cost_recorded', 'tenant', p_tenant::text, jsonb_build_object('month', p_month, 'costMinor', p_cost, 'reference', p_reference));
END $$;

-- Monthly reconciliation across companies: charged to companies (price), Meta's cost by our rate card, margin, and
-- the partner's figure, with the difference between the partner and our cost.
CREATE FUNCTION platform_credit_reconciliation(p_token text, p_month date)
RETURNS TABLE (tenant_id uuid, currency text, charges integer, price_minor bigint, cost_minor bigint, margin_minor bigint,
               partner_cost_minor bigint, partner_count integer, difference_minor bigint, partner_reference text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_from date := date_trunc('month', p_month)::date;
BEGIN
  RETURN QUERY
  WITH ours AS (
    SELECT e.tenant_id, a.currency, count(*)::int AS charges, coalesce(sum(-e.amount_minor), 0)::bigint AS price, coalesce(sum(e.cost_minor), 0)::bigint AS cost
    FROM credit_entries e JOIN credit_accounts a ON a.tenant_id = e.tenant_id
    WHERE e.kind = 'charge' AND e.created_at >= v_from AND e.created_at < (v_from + interval '1 month')
    GROUP BY e.tenant_id, a.currency)
  SELECT coalesce(o.tenant_id, p.tenant_id), coalesce(o.currency, p.currency), coalesce(o.charges, 0), coalesce(o.price, 0), coalesce(o.cost, 0),
         coalesce(o.price, 0) - coalesce(o.cost, 0), p.cost_minor, p.message_count,
         CASE WHEN p.cost_minor IS NULL THEN NULL ELSE p.cost_minor - coalesce(o.cost, 0) END, p.reference
  FROM ours o FULL JOIN (SELECT * FROM credit_partner_costs c WHERE c.month = v_from) p ON p.tenant_id = o.tenant_id AND p.currency = o.currency
  ORDER BY 1;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['platform_credit_open_account(text,uuid,text,bigint)', 'platform_credit_publish_rates(text,text,timestamp with time zone,text,jsonb,jsonb)',
    'platform_credit_set_margin(text,uuid,integer)', 'platform_credit_adjust(text,uuid,bigint,text)',
    'platform_credit_record_partner_cost(text,uuid,date,text,bigint,integer,text)', 'platform_credit_reconciliation(text,date)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO cf_ops', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO cf_platform', f);
  END LOOP;
END $$;
