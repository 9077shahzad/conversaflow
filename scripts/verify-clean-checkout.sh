#!/usr/bin/env bash
# Clean-checkout verification: clones the given commit into an empty folder, installs strictly from the lockfile,
# and runs every reported check against a fresh disposable database under the restricted roles.
# Every step stops the run on failure (no "&&" lists, which set -e does not stop on).
# Writes the evidence to docs/reports/evidence/clean-checkout-<commit>.txt in the ORIGINAL repository.
#
#   bash scripts/verify-clean-checkout.sh [commit]      (default: HEAD)
#
# On GitHub (once approved) the same steps run in .github/workflows/ci.yml.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-clean-XXXXXX")"
# The disposable database runs as the postgres account, which must be able to enter the work folder.
chmod 755 "$WORK"
OUT="$REPO/docs/reports/evidence/clean-checkout-${COMMIT:0:7}.txt"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --no-local "$REPO" "$WORK/repo"
cd "$WORK/repo"
git checkout --quiet "$COMMIT"
step() { echo; echo "## $1"; echo "\$ $2"; }
{
  echo "# Clean-checkout verification — commit $COMMIT ($(git log -1 --format=%ci))"
  echo "# Empty folder, fresh clone, install from the frozen lockfile, fresh disposable database."
  echo "# Node $(node --version), pnpm $(pnpm --version), $(uname -sr)"
  step 'Install' 'pnpm install --frozen-lockfile'
  pnpm install --frozen-lockfile --reporter=silent
  echo 'installed exactly as locked'
  step 'Secret scan' 'pnpm secrets:scan'; pnpm -s secrets:scan > "$WORK/secrets.log"; tail -1 "$WORK/secrets.log"
  step 'Lint' 'pnpm lint'; pnpm -s lint
  echo 'lint: no problems'
  step 'Build' 'pnpm build'; pnpm -s build > "$WORK/build.log"
  echo 'build: all packages built'
  step 'Type check' 'pnpm typecheck'; pnpm -s typecheck > "$WORK/typecheck.log"; grep 'Tasks:' "$WORK/typecheck.log"
  # Local evidence run: a PROPOSED exception is reported but does not stop the run. CI runs the strict audit.
  step 'Dependency audit (all packages; production and development/build tools)' 'pnpm deps:audit:local'; pnpm -s deps:audit:local
  bash scripts/with-local-services.sh bash -c '
    set -eo pipefail
    step() { echo; echo "## $1"; echo "\$ $2"; }
    step "Migrations" "pnpm db:migrate"; pnpm -s db:migrate
    step "Isolation check (CI guard)" "pnpm db:check-rls"; pnpm -s db:check-rls > /tmp/cf-rls.log; tail -1 /tmp/cf-rls.log
    step "Database roles used by the tests" "psql: current_user, superuser, bypassrls per URL"
    for v in DATABASE_APP_URL DATABASE_IDENTITY_URL DATABASE_NOTIFY_URL DATABASE_PLATFORM_URL; do
      psql "${!v}" -Atc "select '"'"'$v -> role '"'"' || current_user || '"'"', superuser='"'"' || current_setting('"'"'is_superuser'"'"') || '"'"', bypassrls='"'"' || (select rolbypassrls from pg_roles where rolname = current_user)"
    done
    step "API tests" "pnpm --filter @conversaflow/api test"
    pnpm --filter @conversaflow/api test > /tmp/cf-api-tests.log 2>&1 || { grep -E "FAIL|×" /tmp/cf-api-tests.log; exit 1; }
    grep -E "Test Files|Tests  " /tmp/cf-api-tests.log
    step "Browser checks (English and Arabic, three sizes, security policy)" "pnpm --filter @conversaflow/web e2e"
    pnpm --filter @conversaflow/web e2e > /tmp/cf-e2e.log 2>&1 || { grep -E "failed|✘" /tmp/cf-e2e.log; exit 1; }
    grep -E "^ +[0-9]+ passed" /tmp/cf-e2e.log
  '
  echo; echo "## Result"; echo "ALL CHECKS PASSED for $COMMIT"
} 2>&1 | tee "$OUT"
test "${PIPESTATUS[0]}" = 0
