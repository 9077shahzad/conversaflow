-- 0063 Message credits: fixes from the recheck of 0062 (29 Oct 2026).
--
-- N4  A top-up can be disputed more than once (partial disputes): the amount taken back is tracked, not a flag.
-- N6  Refunds the provider never answers are not retried for ever: attempts are counted and the company and platform
--     are told when a person must look.
-- N5  Platform reconciliation months are calendar months in UTC, explicitly (the partner invoices that way); the
--     company's own statement uses its time zone.

ALTER TABLE credit_topups ADD COLUMN reversed_minor bigint NOT NULL DEFAULT 0 CHECK (reversed_minor >= 0);
ALTER TABLE credit_topups ADD CONSTRAINT credit_topups_reversed_le_amount CHECK (reversed_minor <= amount_minor);
GRANT UPDATE (reversed_minor) ON credit_topups TO cf_app;
DROP INDEX credit_entries_one_reversal;

ALTER TABLE credit_refunds ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0);
GRANT UPDATE (attempts) ON credit_refunds TO cf_app;
GRANT SELECT (attempts) ON credit_refunds TO cf_dispatch;
CREATE OR REPLACE FUNCTION credit_refunds_pending(p_limit integer) RETURNS TABLE (refund_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.tenant_id FROM credit_refunds r
  WHERE r.status = 'pending' AND r.created_at < now() - interval '5 minutes' AND r.attempts < 30
  ORDER BY r.created_at LIMIT least(greatest(p_limit, 1), 500)
$$;

ALTER TABLE credit_notices DROP CONSTRAINT credit_notices_kind_check;
ALTER TABLE credit_notices ADD CONSTRAINT credit_notices_kind_check
  CHECK (kind IN ('low_balance', 'empty', 'topup_failed', 'auto_topup_failed', 'reversal', 'refund_failed', 'refund_stuck'));

CREATE OR REPLACE FUNCTION platform_credit_reconciliation(p_token text, p_month date)
RETURNS TABLE (tenant_id uuid, currency text, charges integer, price_minor bigint, cost_minor bigint, margin_minor bigint,
               partner_cost_minor bigint, partner_count integer, difference_minor bigint, partner_reference text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff uuid := platform_require(p_token, 'platform_owner'); v_from date := date_trunc('month', p_month)::date;
BEGIN
  RETURN QUERY
  WITH ours AS (
    SELECT e.tenant_id, a.currency, count(*)::int AS charges, coalesce(sum(-e.amount_minor), 0)::bigint AS price, coalesce(sum(e.cost_minor), 0)::bigint AS cost
    FROM credit_entries e JOIN credit_accounts a ON a.tenant_id = e.tenant_id
    -- Calendar months in UTC, whatever the session's time zone, matching the partner's monthly invoice (recheck N5).
    WHERE e.kind = 'charge' AND e.created_at >= (v_from::timestamp AT TIME ZONE 'UTC')
      AND e.created_at < ((v_from + interval '1 month')::timestamp AT TIME ZONE 'UTC')
    GROUP BY e.tenant_id, a.currency)
  SELECT coalesce(o.tenant_id, p.tenant_id), coalesce(o.currency, p.currency), coalesce(o.charges, 0), coalesce(o.price, 0), coalesce(o.cost, 0),
         coalesce(o.price, 0) - coalesce(o.cost, 0), p.cost_minor, p.message_count,
         CASE WHEN p.cost_minor IS NULL THEN NULL ELSE p.cost_minor - coalesce(o.cost, 0) END, p.reference
  FROM ours o FULL JOIN (SELECT * FROM credit_partner_costs c WHERE c.month = v_from) p ON p.tenant_id = o.tenant_id AND p.currency = o.currency
  ORDER BY 1;
END $$;
