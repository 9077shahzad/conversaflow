-- 0050 Automations: fixes from the recheck of the W2.1 review fixes (N1, N2).
--
-- The plan's monthly allowance holds a place for a live run while it is under way, marked by reserved_at. Completed
-- runs are counted by the usage counter as before; a run that is stopped, skipped or fails stops holding a place.
-- (Before this, every started run was recorded as "failed" up front and a stopped run never gave its place back.)
ALTER TABLE workflow_runs ADD COLUMN reserved_at timestamptz;
GRANT UPDATE (reserved_at) ON workflow_runs TO cf_app;
CREATE INDEX workflow_runs_reserved ON workflow_runs (tenant_id, reserved_at) WHERE mode = 'live' AND status IN ('running', 'waiting');

ALTER TABLE workflow_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_counters NO FORCE ROW LEVEL SECURITY;
-- Runs under way that already took their first step keep their place.
UPDATE workflow_runs SET reserved_at = started_at WHERE mode = 'live' AND status IN ('running', 'waiting') AND steps_taken > 0 AND reserved_at IS NULL;
-- Up-front "failed" records left by runs that were stopped or skipped, or are still under way, are removed, and the
-- failed counter is lowered by the same number for that month.
WITH gone AS (
  DELETE FROM usage_events e USING workflow_runs r
  WHERE e.key = 'automation_run' AND e.outcome = 'failed' AND r.id::text = e.source_id AND r.status IN ('stopped', 'skipped', 'running', 'waiting')
  RETURNING e.tenant_id, e.period_start)
UPDATE usage_counters c SET used = greatest(c.used - g.n, 0)
FROM (SELECT tenant_id, period_start, count(*) AS n FROM gone GROUP BY 1, 2) g
WHERE c.tenant_id = g.tenant_id AND c.period_start = g.period_start AND c.key = 'automation_executions_failed';
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;
