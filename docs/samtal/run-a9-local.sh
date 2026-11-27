#!/usr/bin/env bash
# Documentation-only A9 preparation runner. Requires PostgreSQL 17, Supabase CLI, tsgo, bun, Python and patch.
# Run from a repository containing the A9 deliverable under docs/samtal, WITHOUT applying its app patch to main.
# Every application/SQL change is made in random temporary copies; no inherited app secrets are passed to tests.
set -euo pipefail
ROOT=$(pwd); W=$(mktemp -d); RESULT="$W/results"; mkdir -p "$RESULT" "$W/repository"
PORT=${A9_LOCAL_PORT:-55529}
as(){ if [ "$(id -u)" = 0 ]; then runuser -u nobody -- "$@"; else "$@"; fi; }
finish(){ as pg_ctl -D "$W/pg/data" -m immediate stop >/dev/null 2>&1 || true; }
trap finish EXIT
# Keep the result/source copies for inspection; the disposable database server always stops at exit.
python3 - "$ROOT" "$W/repository" <<'PYCODE'
import os,pathlib,shutil,sys
source=pathlib.Path(sys.argv[1]);target=pathlib.Path(sys.argv[2])
skip={'.git','.jj','node_modules','.lovable','dist','.output','.nitro','.wrangler','.tanstack'}
for parent,dirs,files in os.walk(source,followlinks=False):
 dirs[:]=[d for d in dirs if d not in skip and not d.startswith('.samtal-') and not (pathlib.Path(parent)/d).is_symlink()]
 for name in files:
  p=pathlib.Path(parent)/name
  if name.startswith('.env') or name.endswith('.tsbuildinfo') or p.is_symlink():continue
  out=target/p.relative_to(source);out.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,out)
PYCODE
ln -s "$ROOT/node_modules" "$W/repository/node_modules"
cat > "$W/safe.py" <<'PY'
import os,subprocess,sys
prefixes=('SUPABASE','VITE_','PG','SAMTAL','LOVABLE','N8N','NYLAS','UNIPILE','INTERNAL','EMAIL_','ANTHROPIC')
e={k:v for k,v in os.environ.items() if not(k.startswith(prefixes) or any(s in k for s in ('SECRET','TOKEN','API_KEY')))}
sys.exit(subprocess.run(sys.argv[2:],cwd=sys.argv[1],env=e).returncode)
PY
python3 "$W/safe.py" "$W/repository" bunx vitest run src > "$RESULT/repository-tests.log" 2>&1
cp -a "$W/repository" "$W/combined"
for f in priority-1-app-patch.diff priority-1-app-patch-remaining.diff a1-a2-app-patch.diff a7-provider-framework.diff a7-hardening.diff v1-migration-app-fix.diff v1-test-migration.diff a3-a4-ring-estim.diff a5-draft-management.diff a6-monitoring.diff a6-integration.diff a9-app.diff; do
 patch -p1 --batch --forward -d "$W/combined" -i "$ROOT/docs/samtal/$f" >> "$RESULT/patches.log"
done
mkdir -p "$W/pg"; if [ "$(id -u)" = 0 ]; then chown nobody "$W" "$W/pg"; fi
as initdb -D "$W/pg/data" -U postgres -A trust --no-locale --encoding=UTF8 > "$RESULT/initdb.log"
as pg_ctl -D "$W/pg/data" -l "$W/pg/log" -o "-k $W/pg -c listen_addresses=127.0.0.1 -p $PORT" -w start >> "$RESULT/initdb.log"
P=(psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres)
"${P[@]}" -c 'CREATE DATABASE a9'
"${P[@]}" -d a9 -f "$ROOT/docs/samtal/a7-local-platform-stubs.sql" > "$RESULT/schema.log" 2>&1
for f in "$ROOT"/supabase/migrations/*.sql; do
 sed -E '/CREATE EXTENSION IF NOT EXISTS (pg_cron|pg_net)/d' "$f" | PGOPTIONS='-c session_replication_role=replica' "${P[@]}" -d a9 >> "$RESULT/schema.log" 2>&1
done
supabase gen types typescript --db-url "postgresql://postgres@127.0.0.1:$PORT/a9?sslmode=disable" --schema public > "$W/baseline-types.ts" 2> "$RESULT/typegen.log"
cp "$W/baseline-types.ts" "$W/repository/src/integrations/supabase/types.ts"
python3 "$W/safe.py" "$W/repository" tsgo -b --noEmit > "$RESULT/repository-types.log" 2>&1
for f in priority-1-coordinated-v2.sql a1-provider-transcript.sql a7-durable-webhook.sql a3-a4-ring-estim.sql a5-draft-management.sql a6-monitoring.sql a6-integration.sql a9-matching.sql a9-lookup-indexes.sql a9-quote-handoff.sql; do
 "${P[@]}" -d a9 -f "$ROOT/docs/samtal/$f" >> "$RESULT/schema.log" 2>&1
done
supabase gen types typescript --db-url "postgresql://postgres@127.0.0.1:$PORT/a9?sslmode=disable" --schema public > "$W/combined/src/integrations/supabase/types.ts" 2>> "$RESULT/typegen.log"
python3 "$W/safe.py" "$W/combined" tsgo -b --noEmit > "$RESULT/combined-types.log" 2>&1
mapfile -t FILES < <(python3 - "$W/combined" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
for p in sorted((root/'src/test').glob('*.test.*')):
 if "execFileSync('patch'" not in p.read_text(): print(p.relative_to(root))
PY
)
python3 "$W/safe.py" "$W/combined" bunx vitest run "${FILES[@]}" > "$RESULT/combined-tests.log" 2>&1
python3 "$W/safe.py" "$W/combined" bunx vite build > "$RESULT/combined-build.log" 2>&1
printf 'Isolated validation complete. Results: %s\n' "$RESULT"
