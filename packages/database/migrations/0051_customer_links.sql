-- 0051 W2.4 (CF-EXT-020): customer control centre, first version.
--
-- A team member gives a customer a private link from a conversation. With it the customer can see where their
-- conversations stand, choose their language, stop or restart messages, change marketing consent, ask for a person
-- or make a complaint. Nothing else: no message history, no other customer's data, no company data.
--
--  * The link carries a random token; only its SHA-256 is stored. The token travels in the address fragment
--    (after #), so it never reaches server logs, proxies or Referer headers; the page sends it in a header.
--  * Every request looks the token up again through one reviewed function owned by cf_channel, which may read only
--    the routing columns of links that are neither revoked nor expired. A revoked or expired link stops at once
--    (acceptance item 3).
--  * Links last 1 to 30 days and can be revoked one by one or all at once for a contact.
--  * Everything the customer does is recorded with the link as evidence, in the audit log and, for consent, in
--    consent_events (source customer_link).

CREATE TABLE customer_links (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  contact_id      uuid NOT NULL,
  -- The conversation the link was sent from; requests made with the link are attached to it.
  conversation_id uuid,
  token_hash      bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users(id),
  revoke_reason   text CHECK (revoke_reason IS NULL OR revoke_reason IN ('revoked_by_team', 'all_revoked', 'replaced')),
  last_used_at    timestamptz,
  uses            integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  UNIQUE (tenant_id, id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE SET NULL (conversation_id)
);
CREATE INDEX customer_links_contact ON customer_links (tenant_id, contact_id, created_at DESC);

-- A link once issued cannot be pointed elsewhere, lengthened or un-revoked.
CREATE FUNCTION customer_links_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id AND NEW.conversation_id IS NOT NULL)
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.expires_at > OLD.expires_at
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
         OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by)) THEN
    RAISE EXCEPTION 'a customer link can only be used, shortened or revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_links_guard BEFORE UPDATE ON customer_links FOR EACH ROW EXECUTE FUNCTION customer_links_guard();

-- What the customer asked for through the link. The team marks each one handled.
CREATE TABLE customer_requests (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  contact_id      uuid NOT NULL,
  link_id         uuid NOT NULL,
  conversation_id uuid,
  kind            text NOT NULL CHECK (kind IN ('talk_to_person', 'complaint')),
  body            text CHECK (body IS NULL OR length(body) <= 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  handled_at      timestamptz,
  handled_by      uuid REFERENCES users(id),
  UNIQUE (tenant_id, id),
  CHECK ((handled_at IS NULL) = (handled_by IS NULL)),
  CHECK (kind <> 'complaint' OR (body IS NOT NULL AND length(btrim(body)) > 0)),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, link_id) REFERENCES customer_links (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE SET NULL (conversation_id)
);
CREATE INDEX customer_requests_open ON customer_requests (tenant_id, created_at DESC) WHERE handled_at IS NULL;
CREATE INDEX customer_requests_conversation ON customer_requests (tenant_id, conversation_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_links', 'customer_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON customer_links, customer_requests TO cf_app;
GRANT UPDATE (expires_at, revoked_at, revoked_by, revoke_reason, last_used_at, uses, conversation_id) ON customer_links TO cf_app;
GRANT UPDATE (handled_at, handled_by) ON customer_requests TO cf_app;

-- The one lookup a customer's request goes through: token hash in, company and contact out, only for a link that is
-- neither revoked nor expired. cf_channel may read just these columns of such links (pinned in check-rls.ts).
GRANT SELECT (id, tenant_id, contact_id, conversation_id, token_hash, expires_at, revoked_at) ON customer_links TO cf_channel;
CREATE POLICY customer_links_route ON customer_links FOR SELECT TO cf_channel USING (revoked_at IS NULL AND expires_at > now());

CREATE FUNCTION customer_link_route(p_hash bytea)
RETURNS TABLE (link_id uuid, tenant_id uuid, contact_id uuid, conversation_id uuid, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, l.tenant_id, l.contact_id, l.conversation_id, l.expires_at FROM customer_links l
  WHERE l.token_hash = p_hash AND l.revoked_at IS NULL AND l.expires_at > now()
$$;
ALTER FUNCTION customer_link_route(bytea) OWNER TO cf_channel;
REVOKE ALL ON FUNCTION customer_link_route(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_link_route(bytea) TO cf_app;

-- Consent changed by the customer through the link.
ALTER TABLE consent_events DROP CONSTRAINT consent_events_source_check;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_source_check
  CHECK (source IN ('inbound_keyword', 'agent_recorded', 'import', 'customer_link'));

-- The conversation's history shows what the customer did through the link.
ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check
  CHECK (kind IN ('assigned', 'unassigned', 'takeover', 'status_changed', 'opted_out', 'opted_in', 'paused', 'resumed', 'retried',
                  'sla_met', 'sla_missed', 'tagged', 'untagged', 'auto_assigned', 'handed_off', 'ai_handoff',
                  'customer_link_issued', 'customer_link_revoked', 'customer_request', 'customer_request_handled',
                  'customer_preferences'));
