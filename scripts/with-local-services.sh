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
CLAMD_PORT="${CLAMD_PORT:-33100}"
OWNER_PW="owner-$(openssl rand -hex 12)"
APP_PW="app-$(openssl rand -hex 12)"
IDENTITY_PW="identity-$(openssl rand -hex 12)"
NOTIFY_PW="notify-$(openssl rand -hex 12)"
PLATFORM_PW="platform-$(openssl rand -hex 12)"

as_pg() { if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }

mkdir -p "$WORK"
[ "$(id -u)" = "0" ] && chown postgres "$WORK"
cleanup() {
  as_pg "$PG_BIN/pg_ctl" -D "$WORK/pg" -m immediate stop >/dev/null 2>&1 || true
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  [ -f "$WORK/clamd.pid" ] && kill "$(cat "$WORK/clamd.pid")" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

as_pg "$PG_BIN/initdb" -D "$WORK/pg" -U postgres -A trust --no-sync >/dev/null
as_pg "$PG_BIN/pg_ctl" -D "$WORK/pg" -o "-p $PG_PORT -k $WORK -c listen_addresses=127.0.0.1 -c fsync=off" -l "$WORK/pg.log" -w start >/dev/null
redis-server --port "$REDIS_PORT" --save '' --appendonly no --daemonize yes >/dev/null

# Real ClamAV engine (clamd) with the local test signature only — see scripts/clamav/README.md.
mkdir -p "$WORK/clamdb" && cp "$ROOT/scripts/clamav/test-signatures.ndb" "$WORK/clamdb/"
cat > "$WORK/clamd.conf" <<CONF
DatabaseDirectory $WORK/clamdb
TCPSocket $CLAMD_PORT
TCPAddr 127.0.0.1
PidFile $WORK/clamd.pid
LogFile $WORK/clamd.log
Foreground no
StreamMaxLength 20M
CONF
[ "$(id -u)" = "0" ] && echo "User root" >> "$WORK/clamd.conf"
TZ=UTC clamd --config-file="$WORK/clamd.conf"   # clamd prints signature dates in local time; always UTC
for i in $(seq 1 60); do
  [ "$(printf 'zPING\0' | timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/$CLAMD_PORT; cat >&3; cat <&3" 2>/dev/null | tr -d '\0')" = "PONG" ] && break
  sleep 0.5
done

# The owner is NOT a superuser: it is subject to forced RLS like everyone else.
as_pg psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -q -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE cf_owner LOGIN CREATEROLE PASSWORD '$OWNER_PW'" \
  -c "CREATE DATABASE conversaflow OWNER cf_owner" >/dev/null
# Trust auth is used only on this disposable loopback cluster.

export DATABASE_URL="postgres://cf_owner:$OWNER_PW@127.0.0.1:$PG_PORT/conversaflow"
# Superuser on this disposable cluster only, for guard tests that need to create conditions the owner cannot.
export DATABASE_SUPERUSER_URL="postgres://postgres@127.0.0.1:$PG_PORT/conversaflow"
export DATABASE_APP_URL="postgres://cf_app:$APP_PW@127.0.0.1:$PG_PORT/conversaflow"
export CF_APP_DB_PASSWORD="$APP_PW"
export DATABASE_IDENTITY_URL="postgres://cf_identity:$IDENTITY_PW@127.0.0.1:$PG_PORT/conversaflow"
export CF_IDENTITY_DB_PASSWORD="$IDENTITY_PW"
export DATABASE_NOTIFY_URL="postgres://cf_notify:$NOTIFY_PW@127.0.0.1:$PG_PORT/conversaflow"
export CF_NOTIFY_DB_PASSWORD="$NOTIFY_PW"
export DATABASE_PLATFORM_URL="postgres://cf_platform:$PLATFORM_PW@127.0.0.1:$PG_PORT/conversaflow"
export CF_PLATFORM_DB_PASSWORD="$PLATFORM_PW"
export SCANNER=clamd
# This harness loads ONLY the local test signature (the official mirror is not reachable here), so the
# official-signature requirement is switched off explicitly. Production refuses this setting.
export SCANNER_REQUIRE_OFFICIAL_SIGNATURES=false
export CLAMD_HOST=127.0.0.1
export CLAMD_PORT="$CLAMD_PORT"
export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
export FILE_URL_SIGNING_KEY="$(openssl rand -base64 32)"
export WEBHOOK_SECRETS_KEY="${WEBHOOK_SECRETS_KEY:-$(openssl rand -base64 32)}"
export FILE_STORAGE_DIR="$WORK/storage"

"$@"
