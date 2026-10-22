-- 0048 Automations: fixes from the independent review of W2.1 (findings L2, L3, L6).
--
-- L6: a message sent by an automation records its run's mode, and a foreign key to the run's (company, id, mode)
-- with a check that it is "live" makes a message from a rehearsal impossible whatever role inserts it (the trigger
-- from 0045 stays as well).
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_tenant_id_mode_key UNIQUE (tenant_id, id, mode);
ALTER TABLE messages ADD COLUMN automation_run_mode text CHECK (automation_run_mode IS NULL OR automation_run_mode = 'live');
ALTER TABLE messages ADD CONSTRAINT messages_automation_live CHECK ((automation_run_id IS NULL) = (automation_run_mode IS NULL));
ALTER TABLE messages ADD CONSTRAINT messages_automation_run_mode_fk FOREIGN KEY (tenant_id, automation_run_id, automation_run_mode)
  REFERENCES workflow_runs (tenant_id, id, mode);
GRANT INSERT (automation_run_mode) ON messages TO cf_app;

-- L2: rehearsal runs are carried out in the request; the worker never picks them up.
ALTER TABLE workflow_runs NO FORCE ROW LEVEL SECURITY;
UPDATE workflow_runs SET next_at = 'infinity' WHERE mode = 'rehearsal';
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;

-- L3: each lease takes at most 20 runs per company, so one busy company cannot hold up the others; rows leased are
-- checked again (as for incoming events) so two workers never lease the same run.
CREATE OR REPLACE FUNCTION automation_claim(p_limit integer, p_lease_seconds integer) RETURNS TABLE (run_id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE workflow_runs r SET lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 600))
  WHERE r.id IN (
    SELECT s.id FROM workflow_runs s
    WHERE s.id IN (
      SELECT q.id FROM (
        SELECT c.id, c.next_at, row_number() OVER (PARTITION BY c.tenant_id ORDER BY c.next_at, c.id) AS n
        FROM workflow_runs c
        WHERE c.status IN ('running', 'waiting') AND c.next_at <= now() AND (c.lease_until IS NULL OR c.lease_until < now())) q
      WHERE q.n <= 20
      ORDER BY q.next_at, q.id
      LIMIT least(greatest(p_limit, 1), 200))
      AND s.status IN ('running', 'waiting') AND s.next_at <= now() AND (s.lease_until IS NULL OR s.lease_until < now())
    FOR UPDATE SKIP LOCKED)
  RETURNING r.id, r.tenant_id
$$;
