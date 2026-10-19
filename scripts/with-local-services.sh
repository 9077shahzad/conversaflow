#!/usr/bin/env bash
# Starts a throw-away PostgreSQL 16 cluster and Redis for local tests, runs the given command, then stops them.
# Uses locally installed binaries (no Docker needed). For day-to-day development, docker-compose.yml is the
# alternative. All passwords here are local-only test values, generated per run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.local/run-$$"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PG_PORT="${PG_PORT:-54329}"
REDIS_PORT="${REDIS_PORT:-63799}"
OWNER_PW="owner-$(openssl rand -hex 12)"
APP_PW="app-$(openssl rand -hex 12)"

as_pg() { if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }

mkdir -p "$WORK"
[ "$(id -u)" = "0" ] && chown postgres "$WORK"
cleanup() {
  as_pg "$PG_BIN/pg_ctl" -D "$WORK/pg" -m immediate stop >/dev/null 2>&1 || true
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

as_pg "$PG_BIN/initdb" -D "$WORK/pg" -U postgres -A trust --no-sync >/dev/null
as_pg "$PG_BIN/pg_ctl" -D "$WORK/pg" -o "-p $PG_PORT -k $WORK -c listen_addresses=127.0.0.1 -c fsync=off" -l "$WORK/pg.log" -w start >/dev/null
redis-server --port "$REDIS_PORT" --save '' --appendonly no --daemonize yes >/dev/null

# The owner is NOT a superuser: it is subject to forced RLS like everyone else.
as_pg psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -q -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE cf_owner LOGIN CREATEROLE PASSWORD '$OWNER_PW'" \
  -c "CREATE DATABASE conversaflow OWNER cf_owner" >/dev/null
# Trust auth is used only on this disposable loopback cluster.

export DATABASE_URL="postgres://cf_owner:$OWNER_PW@127.0.0.1:$PG_PORT/conversaflow"
export DATABASE_APP_URL="postgres://cf_app:$APP_PW@127.0.0.1:$PG_PORT/conversaflow"
export CF_APP_DB_PASSWORD="$APP_PW"
export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
export FILE_URL_SIGNING_KEY="$(openssl rand -base64 32)"
export MFA_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export FILE_STORAGE_DIR="$WORK/storage"

"$@"
