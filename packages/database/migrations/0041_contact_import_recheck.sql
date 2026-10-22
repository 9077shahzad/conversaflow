-- 0041 Contact import: fixes from the recheck of the slice 5 review fixes (findings N3 and L5).
--
-- N3: an import's own consent records are recognised by their source as well as their evidence text. Evidence is free
-- text that a colleague can type when recording a decision, so text alone must not make a record look like the
-- import's (which would let undo delete the contact together with that decision).
CREATE OR REPLACE FUNCTION contacts_delete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.created_by_import IS NULL
     OR EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = OLD.id)
     OR EXISTS (SELECT 1 FROM consent_events e WHERE e.contact_id = OLD.id
                  AND NOT (e.source = 'import' AND coalesce(e.evidence, '') LIKE 'Import ' || OLD.created_by_import::text || ':%'))
     OR EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.contact_id = OLD.id) THEN
    RAISE EXCEPTION 'only a contact created by an import, with no conversation, no other consent decision and no campaign record, can be removed'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;

-- L5: previews that were never imported are cleared after a day for every company, not only when the same company
-- previews again. The worker runs this lookup; it sees only unimported previews older than a day and can only empty
-- their rows (file name, summary and dates stay, so the company still sees that a preview was made).
GRANT SELECT (id, status, created_at, rows) ON import_batches TO cf_dispatch;
GRANT UPDATE (rows) ON import_batches TO cf_dispatch;
CREATE POLICY import_batches_expire_read ON import_batches FOR SELECT TO cf_dispatch
  USING (status = 'previewed' AND created_at < now() - interval '24 hours');
CREATE POLICY import_batches_expire ON import_batches FOR UPDATE TO cf_dispatch
  USING (status = 'previewed' AND created_at < now() - interval '24 hours')
  WITH CHECK (status = 'previewed' AND rows = '[]'::jsonb);

CREATE FUNCTION import_previews_expire(p_limit integer) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH done AS (
    UPDATE import_batches b SET rows = '[]'::jsonb
    WHERE b.id IN (
      SELECT s.id FROM import_batches s
      WHERE s.status = 'previewed' AND s.created_at < now() - interval '24 hours' AND s.rows <> '[]'::jsonb
      LIMIT least(greatest(p_limit, 1), 500)
      FOR UPDATE SKIP LOCKED)
    RETURNING 1)
  SELECT count(*)::integer FROM done
$$;
ALTER FUNCTION import_previews_expire(integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION import_previews_expire(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_previews_expire(integer) TO cf_app;
