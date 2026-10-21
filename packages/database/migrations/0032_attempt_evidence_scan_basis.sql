-- 0032 Evidence behind send outcomes and malware-scan results (owner instructions of 21 Oct 2026).
--
-- 1. send_attempts records every provider attempt and what we learnt from it. A message is shown as "not accepted
--    after 5 attempts" only when all five attempts are recorded as a definite "not accepted"; any attempt with an
--    ambiguous outcome leaves the message uncertain. A provider message id that arrives after we stopped waiting is
--    recorded too ('late_accepted'), so the message can be reconciled without being sent again.
-- 2. Files record what their malware scan was based on, so a result from the local test signature is never presented
--    as a check against current virus definitions.

CREATE TABLE send_attempts (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           uuid NOT NULL,
  message_id          uuid NOT NULL,
  attempt             integer NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  -- accepted: the provider returned its message id | not_accepted: the provider definitely did not accept it (e.g.
  -- rate limit) | rejected: the provider refused it | uncertain: no usable answer (timeout, lost connection, unknown
  -- error) | interrupted: the process stopped after the request may have left | late_accepted: the provider's id
  -- arrived after we had stopped waiting
  outcome             text NOT NULL CHECK (outcome IN ('accepted', 'not_accepted', 'rejected', 'uncertain', 'interrupted', 'late_accepted')),
  code                text CHECK (code IS NULL OR length(code) <= 100),
  provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 200),
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX send_attempts_message ON send_attempts (tenant_id, message_id, attempt);
ALTER TABLE send_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY send_attempts_tenant ON send_attempts FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON send_attempts TO cf_app;   -- append-only evidence

-- official_current: ClamAV with the official signature database, checked as current at scan time
-- unverified_signatures: ClamAV whose official signatures were not loaded or not checked (e.g. the local test signature)
-- test_double: the in-process test scanner (refused in production)
ALTER TABLE files ADD COLUMN scan_basis text CHECK (scan_basis IS NULL OR scan_basis IN ('official_current', 'unverified_signatures', 'test_double'));
ALTER TABLE files ADD COLUMN scan_signature_version integer;
ALTER TABLE files ADD COLUMN scanned_at timestamptz;
