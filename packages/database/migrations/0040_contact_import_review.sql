-- 0040 Contact import: fixes from the independent review of slice 5 (finding M3).
--
-- Undo of an import removes contacts it created. Deleting a contact also deletes its consent history and campaign
-- recipient records (they cascade). A contact is therefore removable only if nothing else has happened to it: no
-- conversation, no consent decision other than the import's own opt-in (for example a customer's withdrawal), and no
-- campaign recipient record. The application checks the same conditions; this trigger is the database's guarantee.
CREATE OR REPLACE FUNCTION contacts_delete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.created_by_import IS NULL
     OR EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = OLD.id)
     OR EXISTS (SELECT 1 FROM consent_events e WHERE e.contact_id = OLD.id
                  AND coalesce(e.evidence, '') NOT LIKE 'Import ' || OLD.created_by_import::text || ':%')
     OR EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.contact_id = OLD.id) THEN
    RAISE EXCEPTION 'only a contact created by an import, with no conversation, no other consent decision and no campaign record, can be removed'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
