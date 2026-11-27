# Samtal test discovery and CI review

Reviewed 2026-11-27 against the checked-in application and migrations, without remote database access.
This is the test inventory and execution guide for the existing policy in root `AGENTS.md`, not another product policy.
Root `AGENTS.md` was left unchanged because its existing content exceeds the platform's size limit; no standing rules were shortened.

## Commands

Install dependencies and a complete PostgreSQL distribution **before** entering isolation. The runners never install
packages or contact providers. From the repository root:

```sh
bun run test                         # Required CI: original src/** and scripts/ci/** discovery
bun run test src/test/samtal         # Focused current Samtal regressions
bun run test:samtal-proposals        # Explicit historical proposal/harness tests only
```

CI's required Tests step runs `sudo -n env PATH="$PATH" python3 scripts/run-tests-isolated.py`.
It does not run the proposal configuration. No required discovery glob was changed.
The opt-in configuration replaces (not concatenates) discovery with `docs/samtal/tests/**/*.{test,spec}.{ts,tsx}`.

### Prerequisites and isolation

- Linux (or a Linux VM/WSL environment with namespace support), Python 3, `unshare`, `ip`, Node and installed Vitest/Bun dependencies.
- Complete PostgreSQL binaries **and extension libraries**, including `dict_snowball`. Ubuntu CI's versioned
  `/usr/lib/postgresql/<version>/bin` is supported by the existing local SQL helper.
- Root network namespaces, or permitted unprivileged user/network namespaces. CI uses passwordless sudo because
  Ubuntu may restrict unprivileged namespaces. If the guard fails, the command exits before Vitest starts.
- A temporary source copy excludes `.env*`, repository hooks/config/index, build output and symbolic links.
  Installed dependencies are linked read-only by convention, not an adversarial filesystem sandbox.
  Only inert Git objects/refs/HEAD are copied for guard tests that inspect committed source.
- The existing `a10-isolated-run.py` checks a distinct network namespace, no external interfaces/routes, enables
  loopback only, creates a fresh HOME, drops inherited credentials, and only then sets the local isolation attestation.
  Local PostgreSQL uses random Unix-socket directories and synthetic rows; services are mocked.
- Never manually set `ESTIM_TEST_NET_ISOLATED=1` as a substitute for the launcher. No shared Supabase URL or key is passed.
- This does not validate real AI, Lynes, STT, external Storage or delivery. Existing remote integration tests stay
  unconfigured and retain their pre-existing skips; no new skip was added to suppress implemented regressions.

The old `run-priority-1*.sh` and `run-a9-local.sh` scripts are historical preparation records, not current default/opt-in
entry points. Do not use them to bypass the isolation launcher or replay applied patches.

## Classification

File paths below are relative to `src/test/` unless explicitly shown otherwise. Classification is based on imports,
installed SQL and checked-in implementation, not stale comments saying “UNAPPLIED”. A1–A10 and coordinated V2
contracts now exist in source/migrations; their regression coverage remains required.

### Direct implemented behavior — required CI

| Files | What is implemented |
| --- | --- |
| `samtal-adapter.test.ts` | Call normalization, file adapter and ingestion |
| `samtal-behandling.test.ts` | Transcript/STT/AI validation, legacy worker branch and purge |
| `samtal-inkorg-steg.test.ts` | Current guarded Inbox step |
| `samtal-rollspel.test.ts` | Current helpers with documentation scenario data, not replacement code |
| `samtal-sida.test.ts` | Current page authorization, settings, audio, state projection |
| `samtal-test-mode.test.ts`, `samtal-titles.test.ts` | Test access/send protection, bounded titles and customer recognition |
| `samtal-a9-matching.test.ts`, `samtal-a9-worker.test.ts`, `samtal-consecutive-calls.test.ts` | Current matching/orchestration, safe resumes, consecutive calls |
| `samtal-a10-ai.test.ts`, `samtal-a10-quote.test.ts`, `samtal-a10-review.test.tsx` | Assignment AI validation, deterministic catalog arithmetic, existing review UI |
| `samtal-a10-safety.test.ts` | The safety helper is now used by default test setup; retain this infrastructure regression despite its stale “proposal” title |

### Implemented behavior with historical fixture machinery — required CI

| Files | Fixture boundary and decision |
| --- | --- |
| `samtal-app-patch.test.ts`, `samtal-app-e2e.test.ts` | V2 guard/page/worker behavior is implemented; removed obsolete patch replay, retained behavior assertions |
| `samtal-a1-a2.test.ts` | Implemented provider transcripts/STT; current-source copy, minimal local SQL fixture |
| `samtal-a3-a4-ring.test.ts` | Implemented Ring identity/validation/drafts; current-source copy, synthetic local SQL |
| `samtal-a5-drafts.test.ts` | Implemented draft/privacy/enrollment behavior; retained |
| `samtal-a6-monitoring.test.ts`, `samtal-a6-integration.test.ts` | Implemented monitoring/verification/recovery; retained |
| `samtal-a7-provider.test.ts`, `samtal-a7-hardening.test.ts` | Implemented provider/SSRF/tenant fencing; retained, no real provider |
| `samtal-a8-failure.test.ts`, `samtal-v2-safety.test.ts` | Coordinated V2 is committed in `20261127103059_…sql`; retain safety/failure coverage even though fixtures read documentation SQL |
| `samtal-retention.test.ts` | Current cleanup/purge assertions remain here; extracted only nested historical V1 SQL tests |
| `samtal-isolation.test.ts` | Base documented SQL corresponds to committed Samtal schema; also contains application boundary regressions |
| `samtal-inkorg.test.ts`, `email-identity-sql.test.ts` | Shared receive/split/channel/security coverage remains required; documentation SQL is fixture input |
| `samtal-a9-sql.test.ts`, `samtal-a10-sql.test.ts` | Implemented SQL safety/quote contracts; retained. A10 fixture now includes committed subsequent task/matching/handoff fixes |
| `samtal-final-local-workflows.test.ts` | Current ordinary/Ring workflow, synthetic services and actual local persistence; retained and fixture refreshed |
| `samtal-a10-full-schema.test.ts` | Current full committed migration stack, applied once; removed erroneous second A1–A10 overlay |

The smaller SQL fixtures are not comprehensive replicas of production. The full-schema test independently executes
the complete committed migration stack with local platform stubs; no SQL proposal or migration file was modified.

### Confirmed historical/unapplied targets — opt-in only

| New path | Evidence and preserved coverage |
| --- | --- |
| `docs/samtal/tests/samtal-integration-preparation.test.ts` | Imports EXCLUSIVELY TEST-ONLY `proposedIntegration`, uses superseded `priority-1-safety-draft.sql`, not current application orchestration |
| `docs/samtal/tests/samtal-postgres-concurrency.test.ts` | Historical V1 SQL/race reproductions and separately documented token amendment; imports the same test-only proposal |
| `docs/samtal/tests/samtal-v1-safety.test.ts` | Extracted `defineSamtalSafetyTests()` from retention; installs historical V1 candidate, distinct from committed coordinated V2 |
| `docs/samtal/tests/samtal-final-a8-evidence.test.ts` | Evaluates the pool declaration in documentation load harness `a8-load.mjs`, not the app worker; preserves exhausted-retry evidence probes |

Three files moved; one nested suite was extracted. All assertions were preserved. Helpers stay under `src/test/helpers/`
because helpers are not automatically discovered and some remain shared with required coverage.

## Failure groups and corrections

1. **Setup policy:** direct Vitest without namespace attestation fails `use_isolated_test_launcher`. CI previously used
   direct Vitest; the default and opt-in commands now use the existing verified guard.
2. **Obsolete patch replay:** nine suites tried to apply historical A1–A7/V2 diffs to already-integrated source.
   Corrected fixtures to load copied current source; did not remove implemented regressions.
3. **Local environment:** sandbox's partial `/usr/bin` PostgreSQL lacks `dict_snowball`; ran with the already-installed
   complete PostgreSQL 17.12 distribution on PATH. No package was downloaded.
4. **Incomplete fixtures:** older A1/A7/V2 SQL lacks selected `kind`; Ring fixture omitted its component; page fixture
   omitted `kind`, `progress`, jobs and match reads; A10 used old SQL that terminalized the lease before handoff and
   a read-only client stub missing insert/filter/limit support. Refreshed only those relevant fixtures.
5. **Stale expectations:** date-only Ring deadlines must not invent 16:00; material/quote rows now retain certainty
   and evidence; recording fetch tests explicitly opt their synthetic policy into the enabled branch. Default-off
   recording protection remains covered in the hardening suite. Queue assertions reflect current persisted AI jobs,
   with dispatch explicitly mocked and existing human reply preserved.
6. **Evidence paths:** historical `/tmp/work/evidence` directories were assumed to exist. Tests now create and clean
   their own random temporary evidence directories; assertions remain intact.
7. **Full-schema replay:** applied migrations were followed by the same documentation DDL, causing duplicate tables.
   The test now applies committed migrations once and compares the shared quote function across Samtal integration.
8. **Sandbox-only Git restrictions:** default guard tests initialize synthetic Git repositories, but Lovable refuses
   `git init`. Those failures remain visible; no guard tests were skipped, weakened or bypassed.

## Exact executed commands and results

Results and final rerun totals are recorded in [the CI review report](ci-review-2026-11-27.md). Commands use only installed tools:

```sh
PATH=/nix/store/as4iy2k6dvylg3pv7j86432xailvp7x7-postgresql-17.12/bin:$PATH bun run test src/test/samtal
PATH=/nix/store/as4iy2k6dvylg3pv7j86432xailvp7x7-postgresql-17.12/bin:$PATH bun run test
PATH=/nix/store/as4iy2k6dvylg3pv7j86432xailvp7x7-postgresql-17.12/bin:$PATH bun run test:samtal-proposals
```

The Nix path is this sandbox's existing PostgreSQL installation, not a portable requirement; on ordinary Linux use
the installed full PostgreSQL distribution. No product module, remote database, migration, flag or deployment changed.