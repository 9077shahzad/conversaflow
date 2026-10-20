-- 0021 Targeted recheck of candidate 3 at 6f78a89 (informational): the business role never deletes invitations
-- (they are revoked instead, keeping the record), so it loses DELETE. A deleted-and-reinserted invitation could
-- otherwise get a fresh 72 hours on the same link.
REVOKE DELETE ON invitations FROM cf_app;
