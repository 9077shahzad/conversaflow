-- 0059 Conversa Operator, slice 1 (Operator addendum v1.0: FR-02, FR-05..FR-08, FR-17, FR-21, FR-23, AR-08):
-- module settings and emergency pause, published rate cards, service cases with structured facts, immutable quote
-- versions with approval, single-use acceptance links, and a case timeline.
--
-- Source of truth: for a tenant on the native workflow, ConversaFlow owns the rate card, the quotes and the customer's
-- acceptance. When a tenant connects an external operations system (later slice), quotes and jobs created there are
-- referenced by external id and not copied as a second master.
--
-- Quote states: draft → pending_approval → approved → sent → accepted;  sent → expired | superseded | withdrawn;
-- draft/pending_approval/approved → withdrawn | superseded.  Accepted is final here: booking is a separate record.

CREATE TABLE op_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id),
  enabled       boolean NOT NULL DEFAULT false,
  mode          text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'assist', 'approval', 'limited')),
  paused        boolean NOT NULL DEFAULT false,
  paused_at     timestamptz,
  paused_by     uuid,
  terms_version integer NOT NULL DEFAULT 1 CHECK (terms_version >= 1),
  terms_en      text NOT NULL DEFAULT '' CHECK (length(terms_en) <= 4000),
  terms_ar      text NOT NULL DEFAULT '' CHECK (length(terms_ar) <= 4000),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid
);

CREATE TABLE op_rate_cards (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  version       integer NOT NULL CHECK (version >= 1),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  card          jsonb NOT NULL,
  note          text CHECK (note IS NULL OR length(note) <= 500),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  published_by  uuid,
  retired_at    timestamptz,
  UNIQUE (tenant_id, version),
  UNIQUE (tenant_id, id),
  CHECK ((status = 'draft') = (published_at IS NULL))
);
CREATE UNIQUE INDEX op_rate_cards_one_published ON op_rate_cards (tenant_id) WHERE status = 'published';

-- A published rate card never changes; it can only be retired (when a newer one is published).
CREATE FUNCTION op_rate_cards_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.card IS DISTINCT FROM OLD.card OR NEW.version IS DISTINCT FROM OLD.version OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id) THEN
    RAISE EXCEPTION 'a published rate card cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status = 'published') OR (OLD.status = 'published' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'a rate card cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER op_rate_cards_guard BEFORE UPDATE ON op_rate_cards FOR EACH ROW EXECUTE FUNCTION op_rate_cards_guard();

CREATE TABLE op_cases (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  conversation_id  uuid NOT NULL,
  contact_id       uuid NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_customer', 'waiting_approval', 'scheduled', 'in_progress', 'exception', 'handed_over', 'closed')),
  -- Structured request (FR-02): each field {state: unknown|unavailable|not_applicable|stated|confirmed, value, original, source, at}.
  facts            jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome          text CHECK (outcome IS NULL OR outcome IN ('completed', 'cancelled', 'not_serviceable', 'no_response', 'duplicate', 'handed_over')),
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  version          integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX op_cases_conversation ON op_cases (tenant_id, conversation_id, created_at);
CREATE INDEX op_cases_open ON op_cases (tenant_id, status, updated_at) WHERE status <> 'closed';

CREATE TABLE op_quotes (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  case_id          uuid NOT NULL,
  number           integer NOT NULL CHECK (number >= 1),      -- version of the quote within its case
  rate_card_id     uuid NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'expired', 'superseded', 'withdrawn')),
  request          jsonb NOT NULL,
  priced           jsonb NOT NULL,
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor      bigint NOT NULL CHECK (total_minor >= 0),
  tax_minor        bigint NOT NULL CHECK (tax_minor >= 0),
  deposit_minor    bigint NOT NULL CHECK (deposit_minor >= 0),
  inspection_only  boolean NOT NULL,
  scope_en         text NOT NULL CHECK (length(scope_en) BETWEEN 1 AND 2000),
  scope_ar         text NOT NULL CHECK (length(scope_ar) BETWEEN 1 AND 2000),
  terms_version    integer NOT NULL,
  terms_en         text NOT NULL,
  terms_ar         text NOT NULL,
  valid_until      timestamptz NOT NULL,
  needs_approval   text[] NOT NULL DEFAULT '{}',
  approved_by      uuid,
  approved_at      timestamptz,
  sent_at          timestamptz,
  sent_message_id  uuid,
  closed_at        timestamptz,
  close_reason     text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (case_id, number),
  FOREIGN KEY (tenant_id, case_id) REFERENCES op_cases (tenant_id, id),
  FOREIGN KEY (tenant_id, rate_card_id) REFERENCES op_rate_cards (tenant_id, id),
  CHECK (status NOT IN ('approved', 'sent', 'accepted') OR cardinality(needs_approval) = 0 OR approved_at IS NOT NULL),
  CHECK (status NOT IN ('sent', 'accepted', 'expired') OR sent_at IS NOT NULL)
);
CREATE INDEX op_quotes_case ON op_quotes (tenant_id, case_id, number);
CREATE INDEX op_quotes_approval ON op_quotes (tenant_id, created_at) WHERE status = 'pending_approval';
CREATE INDEX op_quotes_expiring ON op_quotes (valid_until) WHERE status = 'sent';
-- At most one quote of a case is open (not yet final) at a time.
CREATE UNIQUE INDEX op_quotes_one_open ON op_quotes (case_id) WHERE status IN ('draft', 'pending_approval', 'approved', 'sent');

-- What was priced and promised never changes once the quote leaves draft; only its status moves forward.
CREATE FUNCTION op_quotes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.rate_card_id IS DISTINCT FROM OLD.rate_card_id OR NEW.request IS DISTINCT FROM OLD.request OR NEW.priced IS DISTINCT FROM OLD.priced
     OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
     OR NEW.deposit_minor IS DISTINCT FROM OLD.deposit_minor OR NEW.scope_en IS DISTINCT FROM OLD.scope_en OR NEW.scope_ar IS DISTINCT FROM OLD.scope_ar
     OR NEW.terms_version IS DISTINCT FROM OLD.terms_version OR NEW.terms_en IS DISTINCT FROM OLD.terms_en OR NEW.terms_ar IS DISTINCT FROM OLD.terms_ar
     OR (NEW.valid_until IS DISTINCT FROM OLD.valid_until AND NOT (OLD.status IN ('draft', 'approved') AND NEW.status = 'sent'))
     OR NEW.needs_approval IS DISTINCT FROM OLD.needs_approval OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a quote version cannot be rewritten; make a new version' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('accepted', 'expired', 'superseded', 'withdrawn') THEN
    RAISE EXCEPTION 'a closed quote cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'approved', 'sent', 'withdrawn', 'superseded'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'withdrawn', 'superseded'))
    OR (OLD.status = 'approved' AND NEW.status IN ('sent', 'withdrawn', 'superseded'))
    OR (OLD.status = 'sent' AND NEW.status IN ('accepted', 'expired', 'superseded', 'withdrawn'))) THEN
    RAISE EXCEPTION 'a quote cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER op_quotes_guard BEFORE UPDATE ON op_quotes FOR EACH ROW EXECUTE FUNCTION op_quotes_guard();

-- Single-use, expiring links for the customer to review and accept one quote version.
CREATE TABLE op_quote_links (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  quote_id     uuid NOT NULL,
  contact_id   uuid NOT NULL,
  token_hash   bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES op_quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id)
);
CREATE INDEX op_quote_links_quote ON op_quote_links (tenant_id, quote_id);

-- The customer's acceptance of one exact quote version (FR-08). One per quote; never updated or deleted.
CREATE TABLE op_acceptances (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  quote_id       uuid NOT NULL,
  contact_id     uuid NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('customer_link', 'staff_recorded')),
  link_id        uuid,
  recorded_by    uuid,
  evidence_note  text CHECK (evidence_note IS NULL OR length(evidence_note) BETWEEN 5 AND 500),
  terms_version  integer NOT NULL,
  total_minor    bigint NOT NULL,
  currency       text NOT NULL,
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, quote_id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES op_quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, link_id) REFERENCES op_quote_links (tenant_id, id),
  CHECK ((channel = 'customer_link') = (link_id IS NOT NULL)),
  CHECK (channel <> 'staff_recorded' OR (recorded_by IS NOT NULL AND evidence_note IS NOT NULL))
);

-- The case timeline (FR-17): what happened, who or what did it, and the record it concerns.
CREATE TABLE op_case_events (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  case_id              uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind ~ '^[a-z_]{3,40}$'),
  actor_membership_id  uuid,
  actor_kind           text NOT NULL CHECK (actor_kind IN ('person', 'customer', 'system', 'automation', 'ai')),
  data                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES op_cases (tenant_id, id)
);
CREATE INDEX op_case_events_case ON op_case_events (tenant_id, case_id, created_at);
CREATE FUNCTION op_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER op_case_events_append_only BEFORE UPDATE OR DELETE ON op_case_events FOR EACH ROW EXECUTE FUNCTION op_append_only();
CREATE TRIGGER op_acceptances_append_only BEFORE UPDATE OR DELETE ON op_acceptances FOR EACH ROW EXECUTE FUNCTION op_append_only();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['op_settings', 'op_rate_cards', 'op_cases', 'op_quotes', 'op_quote_links', 'op_acceptances', 'op_case_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO cf_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON op_settings, op_rate_cards, op_cases, op_quotes, op_quote_links, op_acceptances, op_case_events TO cf_app;
GRANT UPDATE (enabled, mode, paused, paused_at, paused_by, terms_version, terms_en, terms_ar, updated_at, updated_by) ON op_settings TO cf_app;
GRANT UPDATE (status, published_at, published_by, retired_at) ON op_rate_cards TO cf_app;
GRANT UPDATE (status, facts, outcome, updated_at, closed_at, version) ON op_cases TO cf_app;
GRANT UPDATE (status, approved_by, approved_at, sent_at, sent_message_id, valid_until, closed_at, close_reason, version) ON op_quotes TO cf_app;
GRANT UPDATE (used_at, revoked_at) ON op_quote_links TO cf_app;

-- Quote link lookup for the public quote page: hash in, the link's company, quote and customer out, only while the
-- link is unused, unrevoked and unexpired.
GRANT SELECT (id, tenant_id, quote_id, contact_id, token_hash, expires_at, used_at, revoked_at) ON op_quote_links TO cf_channel;
CREATE POLICY op_quote_links_route ON op_quote_links FOR SELECT TO cf_channel USING (revoked_at IS NULL AND expires_at > now());
CREATE FUNCTION op_quote_link_route(p_hash bytea) RETURNS TABLE (link_id uuid, tenant_id uuid, quote_id uuid, contact_id uuid, expires_at timestamptz, used boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, l.tenant_id, l.quote_id, l.contact_id, l.expires_at, l.used_at IS NOT NULL FROM op_quote_links l
  WHERE l.token_hash = p_hash AND l.revoked_at IS NULL AND l.expires_at > now()
$$;
ALTER FUNCTION op_quote_link_route(bytea) OWNER TO cf_channel;
REVOKE ALL ON FUNCTION op_quote_link_route(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION op_quote_link_route(bytea) TO cf_app;

-- The worker expires sent quotes past their validity, across companies (scheduling columns only).
GRANT SELECT (id, tenant_id, status, valid_until) ON op_quotes TO cf_dispatch;
CREATE POLICY op_quotes_dispatch_read ON op_quotes FOR SELECT TO cf_dispatch USING (status = 'sent');
CREATE FUNCTION op_quotes_expiring(p_limit integer) RETURNS TABLE (quote_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT q.id, q.tenant_id FROM op_quotes q WHERE q.status = 'sent' AND q.valid_until <= now()
  ORDER BY q.valid_until LIMIT least(greatest(p_limit, 1), 500)
$$;
ALTER FUNCTION op_quotes_expiring(integer) OWNER TO cf_dispatch;
REVOKE ALL ON FUNCTION op_quotes_expiring(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION op_quotes_expiring(integer) TO cf_app;

INSERT INTO permissions (key, description, requires_mfa) VALUES
  ('operator.manage', 'Set up Conversa Operator: services, prices, terms, automation mode and the emergency pause', true),
  ('operator.quote', 'Open service cases and prepare and send quotes from the published price list', false),
  ('operator.approve', 'Approve quotes that need approval (large amounts, discounts, low margin)', true);
INSERT INTO system_role_grants (role_key, permission_key, added_in) VALUES
  ('owner', 'operator.manage', '0059'), ('owner', 'operator.quote', '0059'), ('owner', 'operator.approve', '0059'),
  ('admin', 'operator.manage', '0059'), ('admin', 'operator.quote', '0059'), ('admin', 'operator.approve', '0059'),
  ('supervisor', 'operator.quote', '0059'), ('supervisor', 'operator.approve', '0059'),
  ('agent', 'operator.quote', '0059');
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission_key)
  SELECT r.tenant_id, r.id, g.permission_key FROM roles r JOIN system_role_grants g ON g.role_key = r.key
  WHERE r.is_system AND g.added_in = '0059'
  ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
