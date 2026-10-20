-- 0015 A seat override written by the operations role must expire within the longest pilot (180 days, plus a day of
-- margin), matching platform_enrol_pilot (independent review of candidate 2, L2).
DROP POLICY overrides_ops_insert ON entitlement_overrides;
CREATE POLICY overrides_ops_insert ON entitlement_overrides FOR INSERT TO cf_ops
  WITH CHECK (key = 'seats' AND expires_at IS NOT NULL AND expires_at <= now() + interval '181 days');
