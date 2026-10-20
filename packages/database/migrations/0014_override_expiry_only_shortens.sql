-- 0014 The operations role may only END a seat override, never extend or clear its expiry
-- (independent recheck R4-4). platform_end_pilot sets expires_at = now(); nothing else updates overrides.
DROP POLICY overrides_ops_expire ON entitlement_overrides;
CREATE POLICY overrides_ops_expire ON entitlement_overrides FOR UPDATE TO cf_ops
  USING (key = 'seats') WITH CHECK (key = 'seats' AND expires_at IS NOT NULL AND expires_at <= now());
