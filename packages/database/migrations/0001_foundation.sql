-- 0001 Foundation: extensions, helper functions, schema hardening.
-- Roles cf_app (API/worker) and cf_auth (owner of authentication functions) are created by the
-- migration runner before this file runs, because their passwords come from the environment.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Nobody but the owner may create objects in the public schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO cf_app, cf_auth;
-- cf_auth cannot log in; it needs CREATE only so it can be the owner of the authentication functions.
GRANT CREATE ON SCHEMA public TO cf_auth;

-- Time-ordered, non-enumerable identifiers (UUID version 7).
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  ts bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  b  bytea  := gen_random_bytes(16);
BEGIN
  b := set_byte(b, 0, ((ts >> 40) & 255)::int);
  b := set_byte(b, 1, ((ts >> 32) & 255)::int);
  b := set_byte(b, 2, ((ts >> 24) & 255)::int);
  b := set_byte(b, 3, ((ts >> 16) & 255)::int);
  b := set_byte(b, 4, ((ts >> 8) & 255)::int);
  b := set_byte(b, 5, (ts & 255)::int);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);  -- version 7
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);  -- RFC 4122 variant
  RETURN encode(b, 'hex')::uuid;
END $$;

-- The request context. The API sets these with set_config(..., true) inside each transaction,
-- so they disappear at COMMIT/ROLLBACK and can never leak to the next request on a pooled connection.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

GRANT EXECUTE ON FUNCTION uuid_generate_v7(), app_tenant_id(), app_user_id() TO cf_app, cf_auth;
