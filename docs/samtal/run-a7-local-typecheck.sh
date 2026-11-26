#!/usr/bin/env bash
# TEST-ONLY. Type-checks the combined patched Samtal application against database types generated from a disposable
# local PostgreSQL (127.0.0.1, random temp dir). Never connects to the preview or production database.
# Also runs the directly runnable Samtal suites and the production build in the fully patched copy (SAMTAL unset).
# The five patch-applier suites (a1-a2, a7-*, app-patch, app-e2e) apply the patches themselves and run from the
# unpatched repository instead.
# Usage (from repository root): nix shell nixpkgs#postgresql_17 -c bash docs/samtal/run-a7-local-typecheck.sh
set -euo pipefail
ROOT=$(pwd); W=$(mktemp -d); PORT=55499; chown nobody "$W" 2>/dev/null || true
as() { if [ "$(id -u)" = 0 ]; then runuser -u nobody -- "$@"; else "$@"; fi; }
as initdb -D "$W/data" -U postgres -A trust --no-locale --encoding=UTF8 >/dev/null
as pg_ctl -D "$W/data" -l "$W/log" -o "-k $W -c listen_addresses=127.0.0.1 -p $PORT" -w start >/dev/null
trap 'as pg_ctl -D "$W/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
P="psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $PORT -U postgres"
$P -c "CREATE DATABASE t" >/dev/null
$P -d t -f docs/samtal/a7-local-platform-stubs.sql >/dev/null 2>&1
for f in supabase/migrations/*.sql; do   # structure only: seed rows referencing real companies are not checked
  sed -E '/CREATE EXTENSION IF NOT EXISTS (pg_cron|pg_net)/d' "$f" | PGOPTIONS="-c session_replication_role=replica" $P -d t >/dev/null 2>&1
done
URL="postgresql://postgres@127.0.0.1:$PORT/t?sslmode=disable"
supabase gen types typescript --db-url "$URL" --schema public > "$W/baseline.ts" 2>/dev/null
for f in priority-1-coordinated-v2.sql a1-provider-transcript.sql a7-durable-webhook.sql a3-a4-ring-estim.sql; do $P -d t -f "docs/samtal/$f" >/dev/null 2>&1; done
supabase gen types typescript --db-url "$URL" --schema public > "$W/patched.ts" 2>/dev/null
check() { # $1 = label, $2 = types file, $3.. = patches
  local label=$1 types=$2; shift 2; local C="$W/copy-$label"; mkdir -p "$C"
  git ls-files -z --cached --others --exclude-standard | xargs -0 -I{} cp --parents {} "$C/"; ln -s "$ROOT/node_modules" "$C/node_modules"
  for p in "$@"; do patch -p1 --forward --batch -d "$C" -i "$ROOT/docs/samtal/$p" >/dev/null; done
  cp "$types" "$C/src/integrations/supabase/types.ts"
  (cd "$C" && tsgo -b --noEmit > "$W/$label.txt" 2>&1) || true
  echo "$label: $(grep -c 'error TS' "$W/$label.txt") errors ($(grep 'error TS' "$W/$label.txt" | grep -vc '^src/test/') outside tests)"
  grep 'error TS' "$W/$label.txt" | sed 's/(.*//' | sort | uniq -c || true
}
check control "$W/baseline.ts"
check patched "$W/patched.ts" priority-1-app-patch.diff priority-1-app-patch-remaining.diff a1-a2-app-patch.diff a7-provider-framework.diff a7-hardening.diff v1-migration-app-fix.diff v1-test-migration.diff a3-a4-ring-estim.diff
SUITES="adapter behandling inkorg-steg sida inkorg integration-preparation isolation postgres-concurrency retention rollspel v2-safety"
(cd "$W/copy-patched" && env -u SAMTAL npx vitest run $(for s in $SUITES; do echo "src/test/samtal-$s.test.ts"; done) > "$W/tests.txt" 2>&1) || true
echo "patched tests: $(grep -E 'Tests +[0-9]' "$W/tests.txt")"
(cd "$W/copy-patched" && npx vite build > "$W/build.txt" 2>&1 && echo "patched build: ok") || echo "patched build: FAILED (see $W/build.txt)"
