-- 0064 Messaging and billing route per company, the 360dialog channel, versioned consent wording, partner funding,
-- and the remaining low findings of the message-credit review (owner instructions of 29 Oct 2026).
--
-- Route: every company is on exactly one route. 'meta_direct' (the default, and every existing company): numbers are
-- connected to Meta directly and the company pays Meta; no credit account may exist. 'partner_360dialog': numbers are
-- connected through 360dialog, Meronatic pays the partner, and the company pays ConversaFlow from prepaid credit. The
-- database refuses anything that would mix the two (a credit account on the direct route, a direct number on the
-- partner route, the same number on both, switching route with money or numbers still on the old one).

-- --- Route ----------------------------------------------------------------------------------------------------------
CREATE TABLE messaging_routes (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  route       text NOT NULL CHECK (route IN ('meta_direct', 'partner_360dialog')),
  note        text NOT NULL CHECK (length(note) BETWEEN 5 AND 300),
  changed_by  uuid,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE messaging_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY messaging_routes_tenant ON messaging_routes FOR SELECT TO cf_app USING (tenant_id = app_tenant_id());
GRANT SELECT ON messaging_routes TO cf_app;
CREATE POLICY messaging_routes_ops ON messaging_routes FOR ALL TO cf_ops USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON messaging_routes TO cf_ops;

-- The route of a company; no row means the direct route.
CREATE FUNCTION messaging_route_for(p_tenant uuid) RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT route FROM messaging_routes WHERE tenant_id = p_tenant), 'meta_direct')
$$;

-- A credit account only on the partner route.
CREATE FUNCTION credit_accounts_route_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF messaging_route_for(NEW.tenant_id) <> 'partner_360dialog' THEN
    RAISE EXCEPTION 'prepaid credit is only for companies on the partner route; this company pays Meta directly' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_accounts_route BEFORE INSERT ON credit_accounts FOR EACH ROW EXECUTE FUNCTION credit_accounts_route_check();

-- --- The 360dialog channel ------------------------------------------------------------------------------------------
ALTER TABLE channel_connections DROP CONSTRAINT channel_connections_provider_check;
ALTER TABLE channel_connections ADD CONSTRAINT channel_connections_provider_check CHECK (provider IN ('sandbox', 'whatsapp_cloud', 'dialog360'));
ALTER TABLE provider_accounts DROP CONSTRAINT provider_accounts_provider_check;
ALTER TABLE provider_accounts ADD CONSTRAINT provider_accounts_provider_check CHECK (provider IN ('sandbox', 'whatsapp_cloud', 'dialog360'));
ALTER TABLE channel_connections DROP CONSTRAINT channel_connections_ownership_method_check;
ALTER TABLE channel_connections ADD CONSTRAINT channel_connections_ownership_method_check
  CHECK (ownership_method IS NULL OR ownership_method IN ('embedded_signup_v4', 'partner_embedded_signup'));
ALTER TABLE channel_connections ADD CONSTRAINT channel_connections_partner_needs_ownership
  CHECK (provider <> 'dialog360' OR (ownership_verified_at IS NOT NULL AND ownership_method IS NOT NULL));
-- One live route per number: the same WhatsApp number can never be active on Meta directly and through the partner.
CREATE UNIQUE INDEX channel_connections_one_live_route ON channel_connections (provider_number_id)
  WHERE provider IN ('whatsapp_cloud', 'dialog360') AND status = 'active';

-- A live number must match the company's route (the sandbox test double imitates either).
CREATE FUNCTION channel_connections_route_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text := messaging_route_for(NEW.tenant_id);
BEGIN
  IF NEW.status = 'active' AND ((NEW.provider = 'whatsapp_cloud' AND r <> 'meta_direct') OR (NEW.provider = 'dialog360' AND r <> 'partner_360dialog')) THEN
    RAISE EXCEPTION 'this number''s provider does not match the company''s messaging route (%)', r USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_connections_route BEFORE INSERT OR UPDATE OF status, provider ON channel_connections
  FOR EACH ROW EXECUTE FUNCTION channel_connections_route_check();

-- 360dialog issues one API key per number. Kept sealed (AES-256-GCM, key held by the API and the worker only).
CREATE TABLE partner_channel_keys (
  connection_id  uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sealed_key     text NOT NULL CHECK (sealed_key LIKE 'v1.%'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES channel_connections (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE partner_channel_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_channel_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_channel_keys_tenant ON partner_channel_keys FOR SELECT TO cf_app USING (tenant_id = app_tenant_id());
GRANT SELECT ON partner_channel_keys TO cf_app;
CREATE POLICY partner_channel_keys_ops ON partner_channel_keys FOR ALL TO cf_ops USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON partner_channel_keys TO cf_ops;
-- The console connects partner numbers (the partner's onboarding is not built yet; the platform owner registers them).
CREATE POLICY channel_connections_ops ON channel_connections FOR ALL TO cf_ops USING (true) WITH CHECK (provider = 'dialog360');
GRANT SELECT, INSERT ON channel_connections TO cf_ops;
CREATE POLICY provider_accounts_ops ON provider_accounts FOR ALL TO cf_ops USING (true) WITH CHECK (provider = 'dialog360');
GRANT SELECT, INSERT ON provider_accounts TO cf_ops;

CREATE FUNCTION platform_set_messaging_route(p_token text, p_tenant uuid, p_route text, p_note text) RETURNS void
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
    UPDATE credit_accounts SET status = 'closed', auto_enabled = false WHERE tenant_id = p_tenant AND status = 'active';
  END IF;
  INSERT INTO messaging_routes (tenant_id, route, note, changed_by) VALUES (p_tenant, p_route, btrim(p_note), v_staff)
  ON CONFLICT (tenant_id) DO UPDATE SET route = EXCLUDED.route, note = EXCLUDED.note, changed_by = EXCLUDED.changed_by, changed_at = now();
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'messaging.route_changed', 'tenant', p_tenant::text, jsonb_build_object('from', v_old, 'to', p_route, 'note', btrim(p_note)));
  INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, metadata, hash)
  VALUES (p_tenant, v_staff, 'messaging.route_changed', 'tenant', p_tenant::text, jsonb_build_object('from', v_old, 'to', p_route), ''::bytea);
END $$;
GRANT UPDATE (status, auto_enabled) ON credit_accounts TO cf_ops;

CREATE FUNCTION platform_partner_connect_channel(p_token text, p_tenant uuid, p_number_id text, p_display text, p_label text, p_account_id text, p_sealed_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_account uuid; v_id uuid;
BEGIN
  IF messaging_route_for(p_tenant) <> 'partner_360dialog' THEN
    RAISE EXCEPTION 'put the company on the partner route first' USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO v_account FROM provider_accounts WHERE provider = 'dialog360' AND account_id = p_account_id AND tenant_id = p_tenant;
  IF v_account IS NULL THEN
    INSERT INTO provider_accounts (tenant_id, provider, account_id) VALUES (p_tenant, 'dialog360', p_account_id) RETURNING id INTO v_account;
  END IF;
  INSERT INTO channel_connections (tenant_id, provider, provider_number_id, display_phone, label, account_ref, ownership_verified_at, ownership_method)
  VALUES (p_tenant, 'dialog360', p_number_id, p_display, p_label, v_account, now(), 'partner_embedded_signup') RETURNING id INTO v_id;
  INSERT INTO partner_channel_keys (connection_id, tenant_id, sealed_key) VALUES (v_id, p_tenant, p_sealed_key);
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'messaging.partner_number_connected', 'tenant', p_tenant::text, jsonb_build_object('connection', v_id, 'number', p_number_id));
  INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, metadata, hash)
  VALUES (p_tenant, v_staff, 'channel.connected', 'channel_connection', v_id::text, jsonb_build_object('provider', 'dialog360'), ''::bytea);
  RETURN v_id;
END $$;

-- --- Automatic top-up wording, versioned (owner instruction 6) -----------------------------------------------------
-- Each version and language is kept word for word. Automatic top-up can only be turned on with a version a platform
-- owner has marked approved after legal review; the account keeps the version, language and exact text accepted.
CREATE TABLE credit_consent_texts (
  version          integer NOT NULL CHECK (version >= 1),
  locale           text NOT NULL CHECK (locale IN ('en', 'ar')),
  text             text NOT NULL CHECK (length(text) BETWEEN 20 AND 2000),
  status           text NOT NULL DEFAULT 'awaiting_legal_review' CHECK (status IN ('awaiting_legal_review', 'approved', 'retired')),
  legal_reference  text CHECK (legal_reference IS NULL OR length(legal_reference) BETWEEN 3 AND 200),
  approved_by      uuid,
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version, locale),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL AND legal_reference IS NOT NULL) OR status = 'retired')
);
CREATE FUNCTION credit_consent_texts_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.text IS DISTINCT FROM OLD.text OR NEW.version <> OLD.version OR NEW.locale <> OLD.locale THEN
    RAISE EXCEPTION 'consent wording never changes; add a new version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_consent_texts_frozen BEFORE UPDATE OR DELETE ON credit_consent_texts FOR EACH ROW EXECUTE FUNCTION credit_consent_texts_frozen();
GRANT SELECT ON credit_consent_texts TO cf_app;
GRANT SELECT, INSERT, UPDATE (status, legal_reference, approved_by, approved_at) ON credit_consent_texts TO cf_ops;
INSERT INTO credit_consent_texts (version, locale, text) VALUES
  (1, 'en', 'I authorise ConversaFlow to charge the saved card the amount below whenever our available message credit falls under the threshold, up to the daily limit, until I turn this off.'),
  (1, 'ar', 'أفوّض ConversaFlow بخصم المبلغ المحدد أدناه من البطاقة المحفوظة كلما انخفض رصيد الرسائل المتاح لدينا عن الحد المحدد، وبما لا يتجاوز الحد اليومي، إلى أن أوقف هذا التفويض.');

ALTER TABLE credit_accounts ADD COLUMN auto_consent_version integer;
ALTER TABLE credit_accounts ADD COLUMN auto_consent_locale text CHECK (auto_consent_locale IS NULL OR auto_consent_locale IN ('en', 'ar'));
ALTER TABLE credit_accounts ADD CONSTRAINT credit_accounts_consent_fk FOREIGN KEY (auto_consent_version, auto_consent_locale) REFERENCES credit_consent_texts (version, locale);
-- Wording accepted before versions existed (test data only) no longer counts: automatic top-up is off until accepted again.
ALTER TABLE credit_accounts DISABLE TRIGGER credit_accounts_guard;
ALTER TABLE credit_accounts NO FORCE ROW LEVEL SECURITY;
UPDATE credit_accounts SET auto_enabled = false WHERE auto_enabled;
ALTER TABLE credit_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_accounts ENABLE TRIGGER credit_accounts_guard;
ALTER TABLE credit_accounts ADD CONSTRAINT credit_accounts_auto_needs_version CHECK (NOT auto_enabled OR (auto_consent_version IS NOT NULL AND auto_consent_locale IS NOT NULL));
-- Turning automatic top-up on needs approved wording, accepted word for word.
CREATE FUNCTION credit_accounts_consent_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.auto_enabled AND (NOT OLD.auto_enabled OR NEW.auto_consent_version IS DISTINCT FROM OLD.auto_consent_version
                           OR NEW.auto_consent_text IS DISTINCT FROM OLD.auto_consent_text) THEN
    IF NOT EXISTS (SELECT 1 FROM credit_consent_texts t WHERE t.version = NEW.auto_consent_version AND t.locale = NEW.auto_consent_locale
                   AND t.status = 'approved' AND t.text = NEW.auto_consent_text) THEN
      RAISE EXCEPTION 'automatic top-up needs wording approved after legal review, accepted exactly as shown' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_accounts_consent BEFORE UPDATE ON credit_accounts FOR EACH ROW EXECUTE FUNCTION credit_accounts_consent_check();
GRANT UPDATE (auto_consent_version, auto_consent_locale) ON credit_accounts TO cf_app;

CREATE FUNCTION platform_credit_consent_add(p_token text, p_locale text, p_text text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_version integer;
BEGIN
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM credit_consent_texts WHERE locale = p_locale;
  INSERT INTO credit_consent_texts (version, locale, text) VALUES (v_version, p_locale, btrim(p_text));
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'credits.consent_added', 'credit_consent_text', v_version::text || ':' || p_locale, jsonb_build_object('locale', p_locale));
  RETURN v_version;
END $$;
CREATE FUNCTION platform_credit_consent_set(p_token text, p_version integer, p_locale text, p_status text, p_legal_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner');
BEGIN
  IF p_status NOT IN ('approved', 'retired') THEN RAISE EXCEPTION 'approve or retire' USING ERRCODE = 'check_violation'; END IF;
  IF p_status = 'approved' AND (p_legal_reference IS NULL OR length(btrim(p_legal_reference)) < 3) THEN
    RAISE EXCEPTION 'give the legal review reference' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE credit_consent_texts SET status = p_status,
         legal_reference = CASE WHEN p_status = 'approved' THEN btrim(p_legal_reference) ELSE legal_reference END,
         approved_by = CASE WHEN p_status = 'approved' THEN v_staff ELSE approved_by END,
         approved_at = CASE WHEN p_status = 'approved' THEN now() ELSE approved_at END
  WHERE version = p_version AND locale = p_locale;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such wording' USING ERRCODE = 'check_violation'; END IF;
  -- Retiring wording turns off automatic top-up that relied on it.
  IF p_status = 'retired' THEN
    UPDATE credit_accounts SET auto_enabled = false WHERE auto_enabled AND auto_consent_version = p_version AND auto_consent_locale = p_locale;
  END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'credits.consent_' || p_status, 'credit_consent_text', p_version::text || ':' || p_locale, jsonb_build_object('legalReference', p_legal_reference));
END $$;

-- --- Partner funding (owner instruction 4) --------------------------------------------------------------------------
-- Money paid by customers (credit_topups, the payment provider) and money paid to the partner are separate ledgers.
-- This one records Meronatic's funding of the partner's prepaid balance, the balances the partner reports, and the
-- settings the monitor uses to say when more funding is needed.
CREATE TABLE partner_funding_settings (
  partner                 text PRIMARY KEY CHECK (partner IN ('360dialog')),
  currency                text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- How many units of the partner's currency one unit of each customer currency buys (SAR and AED are pegged to USD).
  fx                      jsonb NOT NULL,
  low_balance_minor       bigint NOT NULL CHECK (low_balance_minor >= 0),
  min_days_cover          numeric(6,2) NOT NULL CHECK (min_days_cover > 0),
  topup_lead_days         numeric(6,2) NOT NULL CHECK (topup_lead_days >= 0),
  safety_bp               integer NOT NULL CHECK (safety_bp BETWEEN 0 AND 20000),
  updated_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO partner_funding_settings (partner, currency, fx, low_balance_minor, min_days_cover, topup_lead_days, safety_bp)
VALUES ('360dialog', 'USD', '{"USD": 1, "SAR": 0.2666, "AED": 0.2723}', 50000, 14, 5, 5000);

CREATE TABLE partner_funding_entries (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  partner       text NOT NULL REFERENCES partner_funding_settings(partner),
  kind          text NOT NULL CHECK (kind IN ('funding', 'invoice', 'fee', 'adjustment')),
  amount_minor  bigint NOT NULL CHECK (amount_minor <> 0),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference     text NOT NULL CHECK (length(reference) BETWEEN 2 AND 200),
  occurred_at   timestamptz NOT NULL,
  recorded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner, kind, reference)
);
CREATE TABLE partner_balance_snapshots (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  partner       text NOT NULL REFERENCES partner_funding_settings(partner),
  balance_minor bigint NOT NULL,
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source        text NOT NULL CHECK (source IN ('partner_api', 'manual')),
  observed_at   timestamptz NOT NULL,
  recorded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_balance_snapshots_latest ON partner_balance_snapshots (partner, observed_at DESC);
CREATE TABLE platform_alerts (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  kind         text NOT NULL CHECK (kind IN ('partner_balance_low', 'partner_cover_short', 'partner_below_buffer', 'partner_balance_stale')),
  subject      text NOT NULL,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  raised_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE UNIQUE INDEX platform_alerts_one_open ON platform_alerts (kind, subject) WHERE resolved_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON partner_funding_settings, partner_funding_entries, partner_balance_snapshots, platform_alerts TO cf_ops;

-- The monitor: what the partner's balance must cover, how long it lasts, and alerts raised or cleared. Runs as the
-- worker's scan role over aggregates only (no message or customer detail leaves it).
GRANT SELECT ON partner_funding_settings, partner_balance_snapshots, partner_funding_entries TO cf_dispatch;
GRANT SELECT, INSERT, UPDATE ON platform_alerts TO cf_dispatch;
GRANT SELECT (tenant_id, kind, cost_minor, created_at) ON credit_entries TO cf_dispatch;
CREATE POLICY credit_entries_dispatch_read ON credit_entries FOR SELECT TO cf_dispatch USING (kind = 'charge');
GRANT SELECT (currency, balance_minor, reserved_minor) ON credit_accounts TO cf_dispatch;
CREATE POLICY credit_accounts_dispatch_liability ON credit_accounts FOR SELECT TO cf_dispatch USING (status = 'active');
GRANT SELECT (tenant_id, route) ON messaging_routes TO cf_dispatch;

CREATE FUNCTION partner_funding_check(p_partner text)
RETURNS TABLE (partner text, currency text, balance_minor bigint, balance_observed_at timestamptz, daily_cost_minor bigint,
               days_cover numeric, required_buffer_minor bigint, customer_liability_minor bigint, open_alerts text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record; b record; v_daily7 numeric; v_daily30 numeric; v_daily numeric; v_liab numeric; v_required numeric; v_cover numeric;
BEGIN
  SELECT * INTO s FROM partner_funding_settings f WHERE f.partner = p_partner;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT x.balance_minor, x.observed_at, x.currency INTO b FROM partner_balance_snapshots x WHERE x.partner = p_partner ORDER BY x.observed_at DESC LIMIT 1;
  -- Meta's cost of what companies on the partner route sent, converted to the partner's currency.
  SELECT coalesce(sum(e.cost_minor * coalesce((s.fx ->> a.currency)::numeric, 0)) FILTER (WHERE e.created_at > now() - interval '7 days'), 0) / 7,
         coalesce(sum(e.cost_minor * coalesce((s.fx ->> a.currency)::numeric, 0)), 0) / 30
    INTO v_daily7, v_daily30
  FROM credit_entries e JOIN credit_accounts a ON a.tenant_id = e.tenant_id
  WHERE e.kind = 'charge' AND e.created_at > now() - interval '30 days';
  v_daily := greatest(v_daily7, v_daily30);
  SELECT coalesce(sum(greatest(a.balance_minor - a.reserved_minor, 0) * coalesce((s.fx ->> a.currency)::numeric, 0)), 0) INTO v_liab
  FROM credit_accounts a WHERE a.status = 'active';
  -- The partner's balance must carry usage until a new top-up lands, with a safety margin; and it should hold at least
  -- what customers have already prepaid and may still send.
  v_required := greatest(v_daily * (s.min_days_cover + s.topup_lead_days) * (10000 + s.safety_bp) / 10000, s.low_balance_minor);
  v_cover := CASE WHEN v_daily > 0 AND b.balance_minor IS NOT NULL THEN round(b.balance_minor / v_daily, 1) END;
  -- Alerts: raised once, cleared when the condition is gone.
  PERFORM 1;
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
ALTER FUNCTION partner_funding_check(text) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION partner_funding_check(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_funding_check(text) TO cf_app;

CREATE FUNCTION platform_partner_record(p_token text, p_partner text, p_what text, p_kind text, p_amount bigint, p_currency text, p_reference text, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner');
BEGIN
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
CREATE FUNCTION platform_partner_settings(p_token text, p_partner text, p_settings jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner');
BEGIN
  UPDATE partner_funding_settings SET
    fx = coalesce(p_settings -> 'fx', fx),
    low_balance_minor = coalesce((p_settings ->> 'lowBalanceMinor')::bigint, low_balance_minor),
    min_days_cover = coalesce((p_settings ->> 'minDaysCover')::numeric, min_days_cover),
    topup_lead_days = coalesce((p_settings ->> 'topupLeadDays')::numeric, topup_lead_days),
    safety_bp = coalesce((p_settings ->> 'safetyBp')::integer, safety_bp),
    updated_by = v_staff, updated_at = now()
  WHERE partner = p_partner;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such partner' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'partner.settings_changed', 'partner', p_partner, p_settings);
END $$;
CREATE FUNCTION platform_partner_overview(p_token text, p_partner text)
RETURNS TABLE (funded_minor bigint, invoiced_minor bigint, fees_minor bigint, adjustments_minor bigint, alerts jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner');
BEGIN
  RETURN QUERY SELECT
    coalesce(sum(amount_minor) FILTER (WHERE kind = 'funding'), 0)::bigint, coalesce(sum(amount_minor) FILTER (WHERE kind = 'invoice'), 0)::bigint,
    coalesce(sum(amount_minor) FILTER (WHERE kind = 'fee'), 0)::bigint, coalesce(sum(amount_minor) FILTER (WHERE kind = 'adjustment'), 0)::bigint,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'data', a.data, 'raisedAt', a.raised_at) ORDER BY a.raised_at), '[]'::jsonb)
       FROM platform_alerts a WHERE a.subject = p_partner AND a.resolved_at IS NULL)
  FROM partner_funding_entries WHERE partner = p_partner;
END $$;

-- --- L6: the database ties ledger entries to what they record ------------------------------------------------------
CREATE OR REPLACE FUNCTION credit_apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  -- Defence in depth (review L6): an entry the application role writes must match the record it stands for.
  IF NEW.kind = 'adjustment' AND current_user <> 'cf_ops' THEN
    RAISE EXCEPTION 'adjustments are made by platform staff only' USING ERRCODE = 'insufficient_privilege';
  ELSIF NEW.kind = 'topup' AND NOT EXISTS (SELECT 1 FROM credit_topups t WHERE t.id = NEW.topup_id AND t.tenant_id = NEW.tenant_id
                                           AND t.status = 'succeeded' AND t.amount_minor = NEW.amount_minor) THEN
    RAISE EXCEPTION 'a top-up entry needs a matching paid top-up' USING ERRCODE = 'check_violation';
  ELSIF NEW.kind = 'reversal' AND NOT EXISTS (SELECT 1 FROM credit_topups t WHERE t.id = NEW.topup_id AND t.tenant_id = NEW.tenant_id
                                              AND t.status = 'succeeded' AND -NEW.amount_minor <= t.amount_minor) THEN
    RAISE EXCEPTION 'a reversal needs a matching paid top-up' USING ERRCODE = 'check_violation';
  ELSIF NEW.kind IN ('refund', 'refund_failed') AND NOT EXISTS (SELECT 1 FROM credit_refunds r WHERE r.id = NEW.refund_id AND r.tenant_id = NEW.tenant_id
                                              AND r.amount_minor = abs(NEW.amount_minor) AND (NEW.kind = 'refund' OR r.status = 'failed')) THEN
    RAISE EXCEPTION 'a refund entry needs its refund' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE credit_accounts SET balance_minor = balance_minor + NEW.amount_minor, reserved_minor = reserved_minor + NEW.reserved_delta,
                             entry_seq = entry_seq + 1
  WHERE tenant_id = NEW.tenant_id AND status = 'active'
  RETURNING balance_minor, reserved_minor, entry_seq INTO a;
  IF NOT FOUND THEN RAISE EXCEPTION 'no open credit account for this company' USING ERRCODE = 'check_violation'; END IF;
  NEW.balance_after := a.balance_minor;
  NEW.reserved_after := a.reserved_minor;
  NEW.seq := a.entry_seq;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;

-- --- L8: the partner's figure is recorded in the company's credit currency (converted first at the pegged rate) ----
CREATE OR REPLACE FUNCTION platform_credit_record_partner_cost(p_token text, p_tenant uuid, p_month date, p_currency text, p_cost bigint, p_count integer, p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_currency text;
BEGIN
  SELECT currency INTO v_currency FROM credit_accounts WHERE tenant_id = p_tenant;
  IF v_currency IS NULL THEN RAISE EXCEPTION 'no credit account for this company' USING ERRCODE = 'check_violation'; END IF;
  IF p_currency <> v_currency THEN
    RAISE EXCEPTION 'record the partner''s figure in the company''s credit currency (%), converted at the pegged rate', v_currency USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO credit_partner_costs (tenant_id, month, currency, cost_minor, message_count, reference, recorded_by)
  VALUES (p_tenant, date_trunc('month', p_month)::date, p_currency, p_cost, p_count, p_reference, v_staff)
  ON CONFLICT (tenant_id, month, currency) DO UPDATE SET cost_minor = EXCLUDED.cost_minor, message_count = EXCLUDED.message_count,
    reference = EXCLUDED.reference, recorded_by = EXCLUDED.recorded_by, recorded_at = now();
  INSERT INTO platform_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (v_staff, 'credits.partner_cost_recorded', 'tenant', p_tenant::text, jsonb_build_object('month', p_month, 'costMinor', p_cost, 'reference', p_reference));
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['platform_set_messaging_route(text,uuid,text,text)',
    'platform_partner_connect_channel(text,uuid,text,text,text,text,text)', 'platform_credit_consent_add(text,text,text)',
    'platform_credit_consent_set(text,integer,text,text,text)',
    'platform_partner_record(text,text,text,text,bigint,text,text,timestamp with time zone)', 'platform_partner_settings(text,text,jsonb)',
    'platform_partner_overview(text,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO cf_ops', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO cf_platform', f);
  END LOOP;
END $$;
