-- 0065 Fixes from the independent review of 0064 (29 Oct 2026).
--
-- H1  Credit accounts opened before routes existed: put on the partner route (or closed when they have a live direct
--     number), and the route check now also runs when an account is reopened.
-- M1  Route changes, number connections and account opening for one company are serialised by the same lock, so no
--     race can leave a company on both routes.
-- M2  A switch back to the direct route is refused while top-ups or refunds are still pending; a closed account can
--     be reopened (it was impossible before).
-- M5  An index for counting a number's service messages in the month.
-- Low Consent: a change of language alone is checked too. Partner funding: liability is part of the buffer, figures
--     must be in the partner's currency, charges of closed accounts still count, and the check refuses to run inside a
--     company's context.

-- --- H1 ----------------------------------------------------------------------------------------------------------
ALTER TABLE credit_accounts DISABLE TRIGGER credit_accounts_guard;
ALTER TABLE credit_accounts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE messaging_routes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_connections NO FORCE ROW LEVEL SECURITY;
UPDATE credit_accounts a SET status = 'closed', auto_enabled = false
WHERE a.status = 'active' AND NOT EXISTS (SELECT 1 FROM messaging_routes r WHERE r.tenant_id = a.tenant_id)
  AND EXISTS (SELECT 1 FROM channel_connections c WHERE c.tenant_id = a.tenant_id AND c.provider = 'whatsapp_cloud' AND c.status = 'active');
INSERT INTO messaging_routes (tenant_id, route, note)
SELECT a.tenant_id, 'partner_360dialog', 'Set by migration 0065: the company already had prepaid credit'
FROM credit_accounts a WHERE a.status = 'active' AND NOT EXISTS (SELECT 1 FROM messaging_routes r WHERE r.tenant_id = a.tenant_id);
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;
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
    IF EXISTS (SELECT 1 FROM credit_topups t WHERE t.tenant_id = p_tenant AND t.status = 'pending')
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
GRANT SELECT (tenant_id, status) ON credit_topups, credit_refunds TO cf_ops;
CREATE POLICY credit_topups_ops_read ON credit_topups FOR SELECT TO cf_ops USING (status = 'pending');
CREATE POLICY credit_refunds_ops_read ON credit_refunds FOR SELECT TO cf_ops USING (status = 'pending');

-- Reopening a closed account (same company, same currency).
CREATE OR REPLACE FUNCTION platform_credit_open_account(p_token text, p_tenant uuid, p_currency text, p_low_threshold bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_existing record; v_reopen boolean;
BEGIN
  IF p_currency NOT IN ('SAR', 'AED', 'USD') THEN RAISE EXCEPTION 'unsupported currency' USING ERRCODE = 'check_violation'; END IF;
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
