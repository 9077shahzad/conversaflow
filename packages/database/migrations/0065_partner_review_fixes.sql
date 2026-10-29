-- 0065 Fixes from the independent review of 0064 (29 Oct 2026).
--
-- H1  Credit accounts opened before routes existed are closed (the migration stops if one still holds money), and the
--     route check now also runs when an account is reopened.
-- M1  Route changes, number connections and account opening for one company are serialised by the same lock, so no
--     race can leave a company on both routes.
-- M2  A switch back to the direct route is refused while top-ups or refunds are still pending; a closed account can
--     be reopened (it was impossible before).
-- M5  An index for counting a number's service messages in the month.
-- Low Consent: a change of language alone is checked too. Partner funding: liability is part of the buffer, figures
--     must be in the partner's currency, charges of closed accounts still count, and the check refuses to run inside a
--     company's context.

-- --- H1 ----------------------------------------------------------------------------------------------------------
-- Accounts opened under 0061, before routes existed, belong to companies that are on the direct route by default. They
-- are closed, never moved to the partner route (that needs the owner's decision per company, and is refused in
-- production). An account that still holds money, held amounts or payments in progress stops the migration instead, so
-- a person settles it first (recheck of 0065, finding 3). No such account exists outside local test databases.
ALTER TABLE credit_accounts DISABLE TRIGGER credit_accounts_guard;
ALTER TABLE credit_accounts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE messaging_routes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_topups NO FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_refunds NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM credit_accounts a
  WHERE a.status = 'active' AND NOT EXISTS (SELECT 1 FROM messaging_routes r WHERE r.tenant_id = a.tenant_id)
    AND (a.balance_minor <> 0 OR a.reserved_minor <> 0
         OR EXISTS (SELECT 1 FROM credit_topups t WHERE t.tenant_id = a.tenant_id AND t.status = 'pending')
         OR EXISTS (SELECT 1 FROM credit_refunds f WHERE f.tenant_id = a.tenant_id AND f.status = 'pending'));
  IF n > 0 THEN
    RAISE EXCEPTION '0065: % credit account(s) of companies on the direct route still hold credit or payments in progress; settle them first', n;
  END IF;
  UPDATE credit_accounts a SET status = 'closed', auto_enabled = false
  WHERE a.status = 'active' AND NOT EXISTS (SELECT 1 FROM messaging_routes r WHERE r.tenant_id = a.tenant_id);
END $$;
ALTER TABLE credit_refunds FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_topups FORCE ROW LEVEL SECURITY;
ALTER TABLE messaging_routes FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_accounts ENABLE TRIGGER credit_accounts_guard;

-- --- M1: one lock per company for everything that depends on its route -------------------------------------------
CREATE OR REPLACE FUNCTION credit_accounts_route_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('messaging_route:' || NEW.tenant_id::text, 0));
    IF messaging_route_for(NEW.tenant_id) <> 'partner_360dialog' THEN
      RAISE EXCEPTION 'prepaid credit is only for companies on the partner route; this company pays Meta directly' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER credit_accounts_route ON credit_accounts;
CREATE TRIGGER credit_accounts_route BEFORE INSERT OR UPDATE OF status ON credit_accounts FOR EACH ROW EXECUTE FUNCTION credit_accounts_route_check();

CREATE OR REPLACE FUNCTION channel_connections_route_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  IF NEW.status = 'active' AND NEW.provider IN ('whatsapp_cloud', 'dialog360') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('messaging_route:' || NEW.tenant_id::text, 0));
    r := messaging_route_for(NEW.tenant_id);
    IF (NEW.provider = 'whatsapp_cloud' AND r <> 'meta_direct') OR (NEW.provider = 'dialog360' AND r <> 'partner_360dialog') THEN
      RAISE EXCEPTION 'this number''s provider does not match the company''s messaging route (%)', r USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- --- M2 ----------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_set_messaging_route(p_token text, p_tenant uuid, p_route text, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_old text; a record;
BEGIN
  IF p_route NOT IN ('meta_direct', 'partner_360dialog') THEN RAISE EXCEPTION 'unknown route' USING ERRCODE = 'check_violation'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 5 THEN RAISE EXCEPTION 'say why' USING ERRCODE = 'check_violation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('messaging_route:' || p_tenant::text, 0));
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) THEN RAISE EXCEPTION 'no such company' USING ERRCODE = 'check_violation'; END IF;
  v_old := messaging_route_for(p_tenant);
  IF v_old = p_route THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM channel_connections c WHERE c.tenant_id = p_tenant AND c.status = 'active' AND c.provider IN ('whatsapp_cloud', 'dialog360')) THEN
    RAISE EXCEPTION 'disconnect the company''s live numbers on the current route first' USING ERRCODE = 'check_violation';
  END IF;
  IF p_route = 'meta_direct' THEN
    SELECT balance_minor, reserved_minor, status INTO a FROM credit_accounts WHERE tenant_id = p_tenant FOR UPDATE;
    IF FOUND AND a.status = 'active' AND (a.balance_minor <> 0 OR a.reserved_minor <> 0) THEN
      RAISE EXCEPTION 'the company still has prepaid credit or held amounts; refund or settle them first' USING ERRCODE = 'check_violation';
    END IF;
    -- A checkout left unpaid expires at the provider within a day; older pending top-ups do not block. A payment that
    -- still arrives for a closed account is recorded and raises an alert for a person to refund it.
    IF EXISTS (SELECT 1 FROM credit_topups t WHERE t.tenant_id = p_tenant AND t.status = 'pending' AND t.created_at > now() - interval '2 days')
       OR EXISTS (SELECT 1 FROM credit_refunds f WHERE f.tenant_id = p_tenant AND f.status = 'pending') THEN
      RAISE EXCEPTION 'top-ups or refunds are still in progress; wait for them to finish' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE credit_accounts SET status = 'closed', auto_enabled = false WHERE tenant_id = p_tenant AND status = 'active';
  END IF;
  INSERT INTO messaging_routes (tenant_id, route, note, changed_by) VALUES (p_tenant, p_route, btrim(p_note), v_staff)
  ON CONFLICT (tenant_id) DO UPDATE SET route = EXCLUDED.route, note = EXCLUDED.note, changed_by = EXCLUDED.changed_by, changed_at = now();
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'messaging.route_changed', 'tenant', p_tenant::text, jsonb_build_object('from', v_old, 'to', p_route, 'note', btrim(p_note)));
  INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, metadata, hash)
  VALUES (p_tenant, v_staff, 'messaging.route_changed', 'tenant', p_tenant::text, jsonb_build_object('from', v_old, 'to', p_route), ''::bytea);
END $$;
GRANT SELECT (tenant_id, status) ON credit_refunds TO cf_ops;
GRANT SELECT (tenant_id, status, created_at) ON credit_topups TO cf_ops;
CREATE POLICY credit_topups_ops_read ON credit_topups FOR SELECT TO cf_ops USING (status = 'pending');
CREATE POLICY credit_refunds_ops_read ON credit_refunds FOR SELECT TO cf_ops USING (status = 'pending');

-- Reopening a closed account (same company, same currency).
CREATE OR REPLACE FUNCTION platform_credit_open_account(p_token text, p_tenant uuid, p_currency text, p_low_threshold bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_existing record; v_reopen boolean;
BEGIN
  IF p_currency NOT IN ('SAR', 'AED', 'USD') THEN RAISE EXCEPTION 'unsupported currency' USING ERRCODE = 'check_violation'; END IF;
  -- The company's route lock first, then the account row: the same order as a route change (no deadlock).
  PERFORM pg_advisory_xact_lock(hashtextextended('messaging_route:' || p_tenant::text, 0));
  SELECT status, currency INTO v_existing FROM credit_accounts WHERE tenant_id = p_tenant FOR UPDATE;
  v_reopen := FOUND;
  IF v_reopen THEN
    IF v_existing.status = 'active' THEN RAISE EXCEPTION 'the company already has a credit account' USING ERRCODE = 'check_violation'; END IF;
    IF v_existing.currency <> p_currency THEN RAISE EXCEPTION 'a reopened account keeps its currency (%)', v_existing.currency USING ERRCODE = 'check_violation'; END IF;
    UPDATE credit_accounts SET status = 'active', low_threshold_minor = greatest(coalesce(p_low_threshold, 0), 0) WHERE tenant_id = p_tenant;
  ELSE
    INSERT INTO credit_accounts (tenant_id, currency, low_threshold_minor, opened_by) VALUES (p_tenant, p_currency, greatest(coalesce(p_low_threshold, 0), 0), v_staff);
  END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, CASE WHEN v_reopen THEN 'credits.account_reopened' ELSE 'credits.account_opened' END, 'tenant', p_tenant::text, jsonb_build_object('currency', p_currency));
END $$;
GRANT UPDATE (status, low_threshold_minor) ON credit_accounts TO cf_ops;

-- --- M5 ----------------------------------------------------------------------------------------------------------
-- Built in the migration while the table is small (nothing is live). Before production volume, replace the monthly
-- count with a counter per number (open-findings.md).
CREATE INDEX messages_service_month ON messages (conversation_id, created_at) WHERE direction = 'out' AND kind <> 'template';

-- --- Low: consent language --------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION credit_accounts_consent_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.auto_enabled AND (NOT OLD.auto_enabled OR NEW.auto_consent_version IS DISTINCT FROM OLD.auto_consent_version
                           OR NEW.auto_consent_locale IS DISTINCT FROM OLD.auto_consent_locale
                           OR NEW.auto_consent_text IS DISTINCT FROM OLD.auto_consent_text) THEN
    IF NOT EXISTS (SELECT 1 FROM credit_consent_texts t WHERE t.version = NEW.auto_consent_version AND t.locale = NEW.auto_consent_locale
                   AND t.status = 'approved' AND t.text = NEW.auto_consent_text) THEN
      RAISE EXCEPTION 'automatic top-up needs wording approved after legal review, accepted exactly as shown' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- --- Low: partner funding ---------------------------------------------------------------------------------------
DROP POLICY credit_accounts_dispatch_liability ON credit_accounts;
CREATE POLICY credit_accounts_dispatch_all ON credit_accounts FOR SELECT TO cf_dispatch USING (true);

CREATE OR REPLACE FUNCTION partner_funding_check(p_partner text)
RETURNS TABLE (partner text, currency text, balance_minor bigint, balance_observed_at timestamptz, daily_cost_minor bigint,
               days_cover numeric, required_buffer_minor bigint, customer_liability_minor bigint, open_alerts text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record; b record; v_daily7 numeric; v_daily30 numeric; v_daily numeric; v_liab numeric; v_required numeric; v_cover numeric;
BEGIN
  -- Platform-wide figures: never from inside a company's context (review: any company session could read them).
  IF coalesce(current_setting('app.tenant_id', true), '') <> '' THEN
    RAISE EXCEPTION 'not available in a company context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO s FROM partner_funding_settings f WHERE f.partner = p_partner;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT x.balance_minor, x.observed_at INTO b FROM partner_balance_snapshots x WHERE x.partner = p_partner AND x.currency = s.currency ORDER BY x.observed_at DESC LIMIT 1;
  -- Meta's cost of what prepaid companies sent (closed accounts included), in the partner's currency.
  SELECT coalesce(sum(e.cost_minor * coalesce((s.fx ->> a.currency)::numeric, 0)) FILTER (WHERE e.created_at > now() - interval '7 days'), 0) / 7,
         coalesce(sum(e.cost_minor * coalesce((s.fx ->> a.currency)::numeric, 0)), 0) / 30
    INTO v_daily7, v_daily30
  FROM credit_entries e JOIN credit_accounts a ON a.tenant_id = e.tenant_id
  WHERE e.kind = 'charge' AND e.created_at > now() - interval '30 days';
  v_daily := greatest(v_daily7, v_daily30);
  -- Customers' unspent prepaid credit, at Meta's cost (their price includes our margin): what they may still send.
  SELECT coalesce(sum(greatest(a.balance_minor - a.reserved_minor, 0) * coalesce((s.fx ->> a.currency)::numeric, 0)), 0) INTO v_liab
  FROM credit_accounts a WHERE a.status = 'active';
  -- The balance must carry usage until a new top-up lands (with a safety margin), and cover what customers have prepaid.
  v_required := greatest(v_daily * (s.min_days_cover + s.topup_lead_days) * (10000 + s.safety_bp) / 10000, s.low_balance_minor, v_liab);
  v_cover := CASE WHEN v_daily > 0 AND b.balance_minor IS NOT NULL THEN round(b.balance_minor / v_daily, 1) END;
  IF b.balance_minor IS NULL OR b.observed_at < now() - interval '24 hours' THEN
    INSERT INTO platform_alerts (kind, subject, data) VALUES ('partner_balance_stale', p_partner, jsonb_build_object('lastObservedAt', b.observed_at)) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE platform_alerts SET resolved_at = now() WHERE kind = 'partner_balance_stale' AND subject = p_partner AND resolved_at IS NULL;
  END IF;
  IF b.balance_minor IS NOT NULL AND b.balance_minor < s.low_balance_minor THEN
    INSERT INTO platform_alerts (kind, subject, data) VALUES ('partner_balance_low', p_partner, jsonb_build_object('balanceMinor', b.balance_minor, 'thresholdMinor', s.low_balance_minor)) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE platform_alerts SET resolved_at = now() WHERE kind = 'partner_balance_low' AND subject = p_partner AND resolved_at IS NULL;
  END IF;
  IF v_cover IS NOT NULL AND v_cover < s.min_days_cover THEN
    INSERT INTO platform_alerts (kind, subject, data) VALUES ('partner_cover_short', p_partner, jsonb_build_object('daysCover', v_cover, 'minDays', s.min_days_cover)) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE platform_alerts SET resolved_at = now() WHERE kind = 'partner_cover_short' AND subject = p_partner AND resolved_at IS NULL;
  END IF;
  IF b.balance_minor IS NOT NULL AND b.balance_minor < v_required THEN
    INSERT INTO platform_alerts (kind, subject, data) VALUES ('partner_below_buffer', p_partner, jsonb_build_object('balanceMinor', b.balance_minor, 'requiredMinor', round(v_required))) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE platform_alerts SET resolved_at = now() WHERE kind = 'partner_below_buffer' AND subject = p_partner AND resolved_at IS NULL;
  END IF;
  RETURN QUERY SELECT p_partner, s.currency, b.balance_minor, b.observed_at, round(v_daily)::bigint, v_cover, round(v_required)::bigint, round(v_liab)::bigint,
    ARRAY(SELECT x.kind FROM platform_alerts x WHERE x.subject = p_partner AND x.resolved_at IS NULL ORDER BY x.kind);
END $$;

CREATE OR REPLACE FUNCTION platform_partner_record(p_token text, p_partner text, p_what text, p_kind text, p_amount bigint, p_currency text, p_reference text, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_currency text;
BEGIN
  SELECT currency INTO v_currency FROM partner_funding_settings WHERE partner = p_partner;
  IF v_currency IS NULL THEN RAISE EXCEPTION 'no such partner' USING ERRCODE = 'check_violation'; END IF;
  IF p_currency <> v_currency THEN
    RAISE EXCEPTION 'record partner figures in the partner''s currency (%)', v_currency USING ERRCODE = 'check_violation';
  END IF;
  IF p_what = 'balance' THEN
    INSERT INTO partner_balance_snapshots (partner, balance_minor, currency, source, observed_at, recorded_by)
    VALUES (p_partner, p_amount, p_currency, 'manual', coalesce(p_at, now()), v_staff);
  ELSIF p_what = 'entry' THEN
    INSERT INTO partner_funding_entries (partner, kind, amount_minor, currency, reference, occurred_at, recorded_by)
    VALUES (p_partner, p_kind, p_amount, p_currency, p_reference, coalesce(p_at, now()), v_staff);
  ELSE RAISE EXCEPTION 'balance or entry' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'partner.' || p_what || '_recorded', 'partner', p_partner, jsonb_build_object('kind', p_kind, 'amountMinor', p_amount, 'currency', p_currency, 'reference', p_reference));
END $$;

-- --- Payment events that cannot be applied (recheck of 0065, findings 1 and 2) ----------------------------------------
-- A signed provider event that names a top-up we do not have, does not match it, or arrives for a closed account cannot
-- become right by sending it again. It is kept here, answered as received, and raises an alert for a person (the money
-- may have been taken: it is refunded by hand). Platform-wide: the company in the event may not even exist here.
CREATE TABLE credit_unmatched_events (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  provider      text NOT NULL,
  event_id      text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  type          text NOT NULL CHECK (length(type) <= 60),
  reason        text NOT NULL CHECK (reason IN ('mismatch', 'unknown_topup', 'no_account', 'dispute_uncredited')),
  tenant_ref    text CHECK (length(tenant_ref) <= 60),
  topup_ref     text CHECK (length(topup_ref) <= 60),
  provider_ref  text CHECK (length(provider_ref) <= 200),
  amount_minor  bigint,
  currency      text CHECK (length(currency) <= 3),
  received_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  UNIQUE (provider, event_id)
);
GRANT SELECT, UPDATE (resolved_at) ON credit_unmatched_events TO cf_ops;
GRANT SELECT, INSERT ON credit_unmatched_events TO cf_dispatch;
ALTER TABLE platform_alerts DROP CONSTRAINT platform_alerts_kind_check;
ALTER TABLE platform_alerts ADD CONSTRAINT platform_alerts_kind_check
  CHECK (kind IN ('partner_balance_low', 'partner_cover_short', 'partner_below_buffer', 'partner_balance_stale', 'payment_unmatched', 'refund_stuck'));

CREATE FUNCTION credit_record_unmatched(p_provider text, p_event_id text, p_type text, p_reason text, p_tenant text, p_topup text,
                                        p_provider_ref text, p_amount bigint, p_currency text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_new boolean;
BEGIN
  INSERT INTO credit_unmatched_events (provider, event_id, type, reason, tenant_ref, topup_ref, provider_ref, amount_minor, currency)
  VALUES (left(p_provider, 30), p_event_id, left(p_type, 60), p_reason, left(p_tenant, 60), left(p_topup, 60), left(p_provider_ref, 200), p_amount, left(p_currency, 3))
  ON CONFLICT (provider, event_id) DO NOTHING;
  v_new := FOUND;
  -- A top-up of ours paid while its account was closed: held for a person, so no later webhook or lookup credits it
  -- while a refund by hand may be under way. (A different amount or reference is a separate payment; the top-up itself
  -- may still be paid normally, so it is not held.)
  IF p_reason IN ('no_account', 'dispute_uncredited') AND p_topup ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    UPDATE credit_topups SET review_hold = true WHERE id = p_topup::uuid AND provider = p_provider AND tenant_id::text = p_tenant AND status <> 'succeeded';
  END IF;
  -- Raised at once; cleared only by credit_alerts_refresh, from the open events (no race with a resolution).
  INSERT INTO platform_alerts (kind, subject, data)
  VALUES ('payment_unmatched', left(p_provider, 30), jsonb_build_object('lastEventId', p_event_id, 'reason', p_reason))
  ON CONFLICT DO NOTHING;
  RETURN v_new;
END $$;
ALTER FUNCTION credit_record_unmatched(text, text, text, text, text, text, text, bigint, text) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION credit_record_unmatched(text, text, text, text, text, text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credit_record_unmatched(text, text, text, text, text, text, text, bigint, text) TO cf_app;

-- The unmatched payment events, for a platform owner (the alert says how many are waiting; this shows them).
CREATE FUNCTION platform_credit_unmatched(p_token text)
RETURNS TABLE (id uuid, provider text, event_id text, type text, reason text, tenant_ref text, topup_ref text, provider_ref text,
               amount_minor bigint, currency text, received_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner');
BEGIN
  RETURN QUERY SELECT u.id, u.provider, u.event_id, u.type, u.reason, u.tenant_ref, u.topup_ref, u.provider_ref, u.amount_minor, u.currency, u.received_at
  FROM credit_unmatched_events u WHERE u.resolved_at IS NULL ORDER BY u.received_at DESC LIMIT 200;
END $$;
ALTER FUNCTION platform_credit_unmatched(text) OWNER TO cf_ops;
REVOKE ALL ON FUNCTION platform_credit_unmatched(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_credit_unmatched(text) TO cf_platform;

-- --- Recovery when the provider's notices stop (owner instruction of 29 Oct, point 2) ---------------------------------
-- Top-ups still pending (or automatic ones closed as unconfirmed in the last three days) are looked up with the provider
-- directly, at most every ten minutes, so a payment whose webhooks were all lost is still credited, once.
ALTER TABLE credit_topups ADD COLUMN checked_at timestamptz;
-- Held for a person: a payment for this top-up could not be applied (closed account, different amount). Nothing credits
-- it automatically until a platform owner decides: credit it, or record that it was refunded by hand (recheck of
-- e60ef18, M1 and M2).
ALTER TABLE credit_topups ADD COLUMN review_hold boolean NOT NULL DEFAULT false;
-- Released by a person to be credited: looked up whatever its status or age, until credited.
ALTER TABLE credit_topups ADD COLUMN released_at timestamptz;
GRANT SELECT (review_hold) ON credit_topups TO cf_app, cf_dispatch;
-- The hold is set by the payment-event transaction itself (cf_app, in the company's context), never released by it.
GRANT UPDATE (review_hold) ON credit_topups TO cf_app;
GRANT UPDATE (checked_at) ON credit_topups TO cf_app;
CREATE POLICY credit_topups_dispatch_check ON credit_topups FOR SELECT TO cf_dispatch
  USING (status = 'pending' OR (status = 'cancelled' AND failure_reason = 'not_confirmed'));
GRANT SELECT (id, tenant_id, provider, provider_ref, kind, status, failure_reason, created_at, checked_at, released_at) ON credit_topups TO cf_dispatch;
CREATE FUNCTION credit_topups_to_check(p_provider text, p_limit integer) RETURNS TABLE (topup_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.tenant_id FROM credit_topups t
  -- An automatic top-up whose charge answer was lost has no reference yet: it is found at the provider by our top-up id.
  WHERE t.provider = p_provider AND (t.provider_ref IS NOT NULL OR t.kind = 'auto') AND t.created_at < now() - interval '10 minutes'
    AND (t.checked_at IS NULL OR t.checked_at < now() - interval '10 minutes')
    AND NOT t.review_hold
    AND ((t.created_at > now() - interval '30 days'
          AND (t.status = 'pending' OR (t.status = 'cancelled' AND t.failure_reason = 'not_confirmed' AND t.created_at > now() - interval '3 days')))
         OR (t.released_at IS NOT NULL AND t.status <> 'succeeded'))
  ORDER BY t.checked_at NULLS FIRST, t.created_at LIMIT least(greatest(p_limit, 1), 500)
$$;
ALTER FUNCTION credit_topups_to_check(text, integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION credit_topups_to_check(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credit_topups_to_check(text, integer) TO cf_app;

-- A platform owner closes an unmatched event once it is dealt with (refunded at the provider, or credited by hand).
ALTER TABLE credit_unmatched_events ADD COLUMN resolution text CHECK (resolution IS NULL OR length(resolution) BETWEEN 5 AND 500);
ALTER TABLE credit_unmatched_events ADD COLUMN resolved_by uuid;
GRANT UPDATE (resolved_at, resolution, resolved_by) ON credit_unmatched_events TO cf_ops;

-- --- Recheck of 521e0af ---------------------------------------------------------------------------------------------

-- Refunds the provider has not finished after the retry count are kept being asked about once a day (finding 3).
ALTER TABLE credit_refunds ADD COLUMN checked_at timestamptz;
GRANT UPDATE (checked_at) ON credit_refunds TO cf_app;
GRANT SELECT (provider_ref, checked_at, attempts) ON credit_refunds TO cf_dispatch;
CREATE OR REPLACE FUNCTION credit_refunds_pending(p_limit integer) RETURNS TABLE (refund_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.tenant_id FROM credit_refunds r
  WHERE r.status = 'pending' AND r.created_at < now() - interval '5 minutes'
    AND (r.attempts < 30 OR (r.provider_ref IS NOT NULL AND (r.checked_at IS NULL OR r.checked_at < now() - interval '1 day')))
  ORDER BY r.created_at LIMIT least(greatest(p_limit, 1), 500)
$$;

-- Platform alerts worked out from the current state, every minute by the worker (findings 3 and 5): a payment event
-- waiting for a person, or a refund stuck past its retries. Raised while true, cleared when no longer true.
CREATE FUNCTION credit_alerts_refresh() RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p text;
BEGIN
  IF coalesce(current_setting('app.tenant_id', true), '') <> '' THEN
    RAISE EXCEPTION 'not available in a company context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO platform_alerts (kind, subject, data)
  SELECT 'payment_unmatched', u.provider, jsonb_build_object('open', count(*)) FROM credit_unmatched_events u WHERE u.resolved_at IS NULL GROUP BY u.provider
  ON CONFLICT DO NOTHING;
  UPDATE platform_alerts a SET resolved_at = now() WHERE a.kind = 'payment_unmatched' AND a.resolved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM credit_unmatched_events u WHERE u.provider = a.subject AND u.resolved_at IS NULL);
  INSERT INTO platform_alerts (kind, subject, data)
  SELECT 'refund_stuck', 'refunds', jsonb_build_object('count', count(*)) FROM credit_refunds r WHERE r.status = 'pending' AND r.attempts >= 30 HAVING count(*) > 0
  ON CONFLICT DO NOTHING;
  UPDATE platform_alerts a SET resolved_at = now() WHERE a.kind = 'refund_stuck' AND a.resolved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM credit_refunds r WHERE r.status = 'pending' AND r.attempts >= 30);
  RETURN ARRAY(SELECT a.kind || ':' || a.subject FROM platform_alerts a WHERE a.kind IN ('payment_unmatched', 'refund_stuck') AND a.resolved_at IS NULL ORDER BY 1);
END $$;
ALTER FUNCTION credit_alerts_refresh() OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION credit_alerts_refresh() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credit_alerts_refresh() TO cf_app;

-- --- Recheck of e60ef18: the hand-off to a person -------------------------------------------------------------------
GRANT UPDATE (review_hold) ON credit_topups TO cf_dispatch;
CREATE POLICY credit_topups_dispatch_hold ON credit_topups FOR UPDATE TO cf_dispatch USING (status <> 'succeeded') WITH CHECK (status <> 'succeeded');
CREATE POLICY credit_topups_dispatch_hold_read ON credit_topups FOR SELECT TO cf_dispatch USING (released_at IS NOT NULL AND status <> 'succeeded');

-- A platform owner closes a kept payment with one of three decisions:
--   credit   the payment is genuine and the company's account is open: the hold is lifted and the next lookup (or the
--            provider's retry) credits it, once;
--   refunded the money was returned by hand at the provider: the top-up is closed and can never be credited;
--   closed   no top-up of ours is involved (another environment's event, for example): recorded only.
CREATE FUNCTION platform_credit_unmatched_resolve(p_token text, p_id uuid, p_action text, p_resolution text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); u record; v_topup uuid; v_held boolean;
BEGIN
  IF p_action NOT IN ('credit', 'refunded', 'closed') THEN RAISE EXCEPTION 'credit, refunded or closed' USING ERRCODE = 'check_violation'; END IF;
  IF p_resolution IS NULL OR length(btrim(p_resolution)) < 5 THEN RAISE EXCEPTION 'say what was done' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO u FROM credit_unmatched_events WHERE id = p_id AND resolved_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such open event' USING ERRCODE = 'check_violation'; END IF;
  IF u.topup_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_topup := u.topup_ref::uuid; END IF;
  -- The top-up first, then its records: one lock order for every resolution of the same top-up.
  SELECT t.review_hold INTO v_held FROM credit_topups t WHERE t.id = v_topup AND t.provider = u.provider AND t.tenant_id::text = u.tenant_ref FOR UPDATE;
  PERFORM 1 FROM credit_unmatched_events WHERE id = p_id AND resolved_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such open event' USING ERRCODE = 'check_violation'; END IF;
  IF p_action = 'closed' AND v_held THEN
    RAISE EXCEPTION 'this payment belongs to a held top-up of ours: decide credit or refunded' USING ERRCODE = 'check_violation';
  END IF;
  IF p_action IN ('credit', 'refunded') AND v_held IS NOT TRUE THEN
    RAISE EXCEPTION 'no top-up of ours is held for this payment (it may already be credited; check the company''s top-ups); use closed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_action = 'credit' THEN
    -- The bank took this payment back: it can never be credited.
    IF EXISTS (SELECT 1 FROM credit_unmatched_events x WHERE x.provider = u.provider AND x.topup_ref = u.topup_ref AND x.reason = 'dispute_uncredited') THEN
      RAISE EXCEPTION 'this payment was disputed and lost; it cannot be credited (use refunded)' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM credit_accounts a WHERE a.tenant_id::text = u.tenant_ref AND a.status = 'active') THEN
      RAISE EXCEPTION 'reopen the company''s credit account first' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE credit_topups SET review_hold = false, released_at = now(), checked_at = NULL WHERE id = v_topup;
  ELSIF p_action = 'refunded' THEN
    -- Stays held (never looked up or credited again), now closed: refunded by hand, or taken back by the bank.
    UPDATE credit_topups SET status = 'cancelled', failure_reason = 'refunded_by_hand', settled_at = now(), checked_at = 'infinity'
    WHERE id = v_topup AND status <> 'succeeded';
  END IF;
  -- Every open record of the same top-up is closed with it (the webhook and a lookup may both have kept one).
  UPDATE credit_unmatched_events SET resolved_at = now(), resolution = p_action || ': ' || btrim(p_resolution), resolved_by = v_staff
  WHERE resolved_at IS NULL AND (id = p_id OR (p_action <> 'closed' AND provider = u.provider AND topup_ref = u.topup_ref));
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'credits.unmatched_resolved', 'credit_unmatched_event', p_id::text,
          jsonb_build_object('action', p_action, 'resolution', btrim(p_resolution), 'topup', u.topup_ref, 'tenant', u.tenant_ref));
END $$;
ALTER FUNCTION platform_credit_unmatched_resolve(text, uuid, text, text) OWNER TO cf_ops;
REVOKE ALL ON FUNCTION platform_credit_unmatched_resolve(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_credit_unmatched_resolve(text, uuid, text, text) TO cf_platform;
GRANT SELECT (id, tenant_id, provider, review_hold, released_at), UPDATE (review_hold, released_at, status, failure_reason, settled_at, checked_at) ON credit_topups TO cf_ops;
CREATE POLICY credit_topups_ops_hold ON credit_topups FOR SELECT TO cf_ops USING (review_hold OR released_at IS NOT NULL);
CREATE POLICY credit_topups_ops_hold_update ON credit_topups FOR UPDATE TO cf_ops USING (review_hold) WITH CHECK (status <> 'succeeded');
GRANT SELECT (tenant_id, status) ON credit_accounts TO cf_ops;

-- Only a platform owner's decision lifts a hold (the application can only set one).
CREATE FUNCTION credit_topups_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.review_hold AND NOT NEW.review_hold AND current_user <> 'cf_ops' THEN
    RAISE EXCEPTION 'a held top-up is released only by a platform owner''s decision' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_topups_hold_guard BEFORE UPDATE OF review_hold ON credit_topups FOR EACH ROW EXECUTE FUNCTION credit_topups_hold_guard();
