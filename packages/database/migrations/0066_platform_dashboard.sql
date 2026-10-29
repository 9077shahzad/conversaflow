-- 0066 Platform owner dashboard (owner request of 30 Oct 2026).
--
-- One token-bound function returns the platform's figures for a period as JSON: companies and subscriptions,
-- the contracted monthly subscription value (no invoices exist yet: payments are not live), messaging revenue, Meta's
-- cost and the margin from prepaid credit, customer payments and refunds (tracked apart from partner funding), customers'
-- unspent credit, and open alerts. Totals and per-company figures only; no message content, no customer data.
CREATE FUNCTION platform_dashboard(p_token text, p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_start timestamptz; v_end timestamptz; r jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'choose a period of 1 to 367 days' USING ERRCODE = 'check_violation';
  END IF;
  -- Platform figures are counted in UTC days, as the partner and the payment provider report them.
  v_start := p_from::timestamp AT TIME ZONE 'UTC';
  v_end := (p_to + 1)::timestamp AT TIME ZONE 'UTC';
  SELECT jsonb_build_object(
    'companies', jsonb_build_object(
      'total', (SELECT count(*) FROM tenants),
      'byStatus', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM tenants GROUP BY status) x), '{}'::jsonb),
      'subscriptions', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM subscriptions GROUP BY status) x), '{}'::jsonb),
      'newInPeriod', (SELECT count(*) FROM tenants WHERE created_at >= v_start AND created_at < v_end),
      'onPartnerRoute', (SELECT count(*) FROM messaging_routes WHERE route = 'partner_360dialog'),
      'withCreditAccount', (SELECT count(*) FROM credit_accounts WHERE status = 'active'),
      'newByDay', coalesce((SELECT jsonb_agg(jsonb_build_object('day', d, 'n', n) ORDER BY d) FROM (
         SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d, count(*) AS n FROM tenants
         WHERE created_at >= v_start AND created_at < v_end GROUP BY 1) x), '[]'::jsonb)),
    -- Contracted value of paying subscriptions per month (annual plans divided by 12, extra seats at their add-on price).
    'subscriptionValue', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', currency, 'plan', plan, 'companies', n, 'monthlyMinor', v) ORDER BY currency, plan) FROM (
       SELECT pv.currency::text AS currency, p.code AS plan, count(*) AS n,
              sum(CASE WHEN s.billing_interval = 'year' THEN coalesce(pv.price_annual_cents, pv.price_monthly_cents * 12) / 12.0 ELSE coalesce(pv.price_monthly_cents, 0) END
                  + s.extra_seats * coalesce((SELECT e.addon_price_cents FROM plan_entitlements e WHERE e.plan_version_id = pv.id AND e.key = 'seats'), 0))::bigint AS v
       FROM subscriptions s JOIN plan_versions pv ON pv.id = s.plan_version_id JOIN plans p ON p.id = pv.plan_id
       WHERE s.status IN ('active', 'past_due') GROUP BY 1, 2) x), '[]'::jsonb),
    'trialing', (SELECT count(*) FROM subscriptions WHERE status = 'trialing'),
    -- Prepaid messaging: what companies were charged, Meta's cost of those messages, and the margin, per currency.
    'messaging', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', currency, 'revenueMinor', rev, 'costMinor', cost, 'marginMinor', rev - cost, 'messages', n) ORDER BY currency) FROM (
       SELECT a.currency, -sum(e.amount_minor) AS rev, sum(coalesce(e.cost_minor, 0)) AS cost, count(*) AS n
       FROM credit_entries e JOIN credit_accounts a ON a.tenant_id = e.tenant_id
       WHERE e.kind = 'charge' AND e.created_at >= v_start AND e.created_at < v_end GROUP BY 1) x), '[]'::jsonb),
    'messagingByDay', coalesce((SELECT jsonb_agg(jsonb_build_object('day', d, 'currency', currency, 'revenueMinor', rev, 'costMinor', cost) ORDER BY d, currency) FROM (
       SELECT to_char((e.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d, a.currency, -sum(e.amount_minor) AS rev, sum(coalesce(e.cost_minor, 0)) AS cost
       FROM credit_entries e JOIN credit_accounts a ON a.tenant_id = e.tenant_id
       WHERE e.kind = 'charge' AND e.created_at >= v_start AND e.created_at < v_end GROUP BY 1, 2) x), '[]'::jsonb),
    'messagingByCompany', coalesce((SELECT jsonb_agg(jsonb_build_object('tenantId', tenant_id, 'name', legal_name, 'currency', currency, 'revenueMinor', rev,
       'costMinor', cost, 'marginMinor', rev - cost, 'messages', n, 'balanceMinor', balance) ORDER BY rev DESC) FROM (
       SELECT t.id AS tenant_id, t.legal_name, a.currency, a.balance_minor - a.reserved_minor AS balance,
              coalesce(-sum(e.amount_minor) FILTER (WHERE e.kind = 'charge'), 0) AS rev,
              coalesce(sum(coalesce(e.cost_minor, 0)) FILTER (WHERE e.kind = 'charge'), 0) AS cost,
              count(e.id) FILTER (WHERE e.kind = 'charge') AS n
       FROM credit_accounts a JOIN tenants t ON t.id = a.tenant_id
       LEFT JOIN credit_entries e ON e.tenant_id = a.tenant_id AND e.created_at >= v_start AND e.created_at < v_end
       GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC LIMIT 100) x), '[]'::jsonb),
    -- Customer payments, kept apart from partner funding.
    'customerPayments', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', currency, 'toppedUpMinor', topped, 'refundedMinor', refunded, 'reversedMinor', reversed) ORDER BY currency) FROM (
       SELECT a.currency, coalesce(sum(e.amount_minor) FILTER (WHERE e.kind = 'topup'), 0) AS topped,
              coalesce(-sum(e.amount_minor) FILTER (WHERE e.kind IN ('refund')), 0) + coalesce(-sum(e.amount_minor) FILTER (WHERE e.kind = 'refund_failed'), 0) AS refunded,
              coalesce(-sum(e.amount_minor) FILTER (WHERE e.kind = 'reversal'), 0) AS reversed
       FROM credit_entries e JOIN credit_accounts a ON a.tenant_id = e.tenant_id
       WHERE e.kind IN ('topup', 'refund', 'refund_failed', 'reversal') AND e.created_at >= v_start AND e.created_at < v_end GROUP BY 1) x), '[]'::jsonb),
    'customerLiability', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', currency, 'unspentMinor', u) ORDER BY currency) FROM (
       SELECT currency, sum(greatest(balance_minor - reserved_minor, 0)) AS u FROM credit_accounts WHERE status = 'active' GROUP BY 1) x), '[]'::jsonb),
    'alerts', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'subject', subject, 'raisedAt', raised_at, 'data', data) ORDER BY raised_at DESC)
       FROM platform_alerts WHERE resolved_at IS NULL), '[]'::jsonb),
    'unmatchedPayments', (SELECT count(*) FROM credit_unmatched_events WHERE resolved_at IS NULL)
  ) INTO r;
  RETURN r;
END $$;
ALTER FUNCTION platform_dashboard(text, date, date) OWNER TO cf_ops;
REVOKE ALL ON FUNCTION platform_dashboard(text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_dashboard(text, date, date) TO cf_platform;
-- Seat add-on prices for the subscription value (the price list, the same for every company).
GRANT SELECT ON plan_entitlements TO cf_ops;
