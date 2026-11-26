#!/usr/bin/env bash
# Documentation/test-only runner. No external database URL, provider credentials or production configuration.
set -euo pipefail
test -f docs/samtal/priority-1-safety-draft.sql || { printf '%s\n' 'Run this script from the repository root.'; exit 1; }
tests=(src/test/samtal-adapter.test.ts src/test/samtal-behandling.test.ts src/test/samtal-inkorg-steg.test.ts src/test/samtal-inkorg.test.ts src/test/samtal-isolation.test.ts src/test/samtal-rollspel.test.ts src/test/samtal-sida.test.ts src/test/samtal-retention.test.ts src/test/samtal-integration-preparation.test.ts src/test/samtal-postgres-concurrency.test.ts)
if command -v nix >/dev/null 2>&1; then
  nix shell nixpkgs#postgresql_17 -c env -u SAMTAL bunx vitest run "${tests[@]}"
else
  # Requires a COMPLETE PostgreSQL 17 installation (including its libraries) and Bun already on PATH.
  command -v initdb >/dev/null; command -v pg_ctl >/dev/null
  env -u SAMTAL bunx vitest run "${tests[@]}"
fi