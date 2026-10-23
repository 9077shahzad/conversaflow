-- 0053 W2.6 (CF-EXT-018): customer promise tracking, first version.
--
-- What the team tells a customer it will do ("I will call you tomorrow", "سنرسل الفني خلال ساعتين") becomes a tracked
-- promise with an owner, a deadline, where it came from and a status:
--   suggested → confirmed → kept | missed → recovered;  suggested → dismissed;  confirmed → cancelled
-- A detection rule may only suggest; a person confirms, unless the company turned on automatic confirmation of
-- detected promises (an approved rule). The worker warns the owner before the deadline and marks a promise missed
-- when the deadline passes without it being kept.

CREATE TABLE promises (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          uuid NOT NULL,
  conversation_id    uuid NOT NULL,
  contact_id         uuid NOT NULL,
  description        text NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 300),
  owner_membership_id uuid,
  due_at             timestamptz NOT NULL,
  source             text NOT NULL CHECK (source IN ('manual', 'rule')),
  source_message_id  uuid,
  status             text NOT NULL CHECK (status IN ('suggested', 'confirmed', 'kept', 'missed', 'recovered', 'dismissed', 'cancelled')),
  -- The words that made a rule suggest it, for the explanation.
  matched_text       text CHECK (matched_text IS NULL OR length(matched_text) <= 200),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_at       timestamptz,
  confirmed_by       uuid REFERENCES users(id),
  warned_at          timestamptz,
  missed_at          timestamptz,
  closed_at          timestamptz,
  closed_by          uuid REFERENCES users(id),
  note               text CHECK (note IS NULL OR length(note) <= 500),
  version            integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  -- A rule suggests at most one promise per message.
  UNIQUE (tenant_id, source_message_id),
  CHECK ((status = 'suggested') = (confirmed_at IS NULL) OR status IN ('dismissed')),
  CHECK (status <> 'confirmed' OR owner_membership_id IS NOT NULL),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES memberships (tenant_id, id),
  FOREIGN KEY (tenant_id, source_message_id) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (source_message_id)
);
CREATE INDEX promises_due ON promises (due_at) WHERE status = 'confirmed';
CREATE INDEX promises_conversation ON promises (tenant_id, conversation_id, due_at);
CREATE INDEX promises_owner ON promises (tenant_id, owner_membership_id, due_at) WHERE status IN ('suggested', 'confirmed', 'missed');

-- Only forward moves; the deadline can change only while the promise is open.
CREATE FUNCTION promises_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.source IS DISTINCT FROM OLD.source OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a promise cannot be moved to another conversation' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'suggested' AND NEW.status IN ('confirmed', 'dismissed'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('kept', 'missed', 'cancelled'))
    OR (OLD.status = 'missed' AND NEW.status IN ('kept', 'recovered'))) THEN
    RAISE EXCEPTION 'a promise cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status NOT IN ('suggested', 'confirmed') AND (NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.description IS DISTINCT FROM OLD.description) THEN
    RAISE EXCEPTION 'a closed or missed promise cannot be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER promises_guard BEFORE UPDATE ON promises FOR EACH ROW EXECUTE FUNCTION promises_guard();

ALTER TABLE promises ENABLE ROW LEVEL SECURITY;
ALTER TABLE promises FORCE ROW LEVEL SECURITY;
CREATE POLICY promises_tenant ON promises FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON promises TO cf_app;
GRANT UPDATE (description, owner_membership_id, due_at, status, confirmed_at, confirmed_by, warned_at, missed_at, closed_at, closed_by, note, version) ON promises TO cf_app;

-- Company setting: detected promises are confirmed automatically (owner by default: the person who wrote it).
ALTER TABLE tenant_settings ADD COLUMN promises_auto_confirm boolean NOT NULL DEFAULT false;
GRANT UPDATE (promises_auto_confirm) ON tenant_settings TO cf_app;

-- The worker finds promises to warn about or mark missed, across companies (scheduling columns only).
GRANT SELECT (id, tenant_id, status, due_at, warned_at) ON promises TO cf_dispatch;
CREATE POLICY promises_dispatch_read ON promises FOR SELECT TO cf_dispatch USING (status = 'confirmed');
CREATE FUNCTION promises_due(p_limit integer) RETURNS TABLE (promise_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, p.tenant_id FROM promises p
  WHERE p.status = 'confirmed' AND (p.due_at <= now() OR (p.warned_at IS NULL AND p.due_at <= now() + interval '1 hour'))
  ORDER BY p.due_at LIMIT least(greatest(p_limit, 1), 500)
$$;
ALTER FUNCTION promises_due(integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION promises_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION promises_due(integer) TO cf_app;

ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check
  CHECK (kind IN ('assigned', 'unassigned', 'takeover', 'status_changed', 'opted_out', 'opted_in', 'paused', 'resumed', 'retried',
                  'sla_met', 'sla_missed', 'tagged', 'untagged', 'auto_assigned', 'handed_off', 'ai_handoff',
                  'customer_link_issued', 'customer_link_revoked', 'customer_request', 'customer_request_handled', 'customer_preferences',
                  'promise_suggested', 'promise_confirmed', 'promise_due_soon', 'promise_missed', 'promise_kept', 'promise_recovered',
                  'promise_dismissed', 'promise_cancelled'));

ALTER TABLE push_jobs DROP CONSTRAINT push_jobs_kind_check;
ALTER TABLE push_jobs ADD CONSTRAINT push_jobs_kind_check CHECK (kind IN ('new_message', 'customer_request', 'test', 'promise_due_soon', 'promise_missed'));
