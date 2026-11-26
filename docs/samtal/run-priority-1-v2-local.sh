#!/usr/bin/env bash
# Test-only. Execute from repository root; never substitutes a real database endpoint.
set -euo pipefail
test -f docs/samtal/priority-1-coordinated-v2.sql
nix shell nixpkgs#postgresql_17 -c env -u SAMTAL bunx vitest run src/test/samtal-*.test.ts