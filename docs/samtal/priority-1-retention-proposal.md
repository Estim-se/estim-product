# Samtal Priority 1 — unapplied privacy/retention proposal

**Documentation only. Not a migration. Not approved for execution.**

The coordinated successor is [priority-1-safety-draft.sql](priority-1-safety-draft.sql), with
[the complete design and rollout contract](priority-1-safety-design.md). The illustrative fragments below
are historical preparation notes, not independent rollout units. Local regression results are reported separately.

Baseline: `main`, `9c3e4c4b3ba0b7ae625558f99ecb3791b03c811d` (2026-11-26).
No current application code calls the proposed functions or depends on the proposed table.
Historical SQL, migrations, generated database types, flags and secrets remain unchanged.

## What the schema-compatible patch does

- Detects error, rejected request and no-row results when private-call content cleanup is persisted.
- Does not finish a private job falsely on those failures; uses the existing bounded retry path and structural error code `private_cleanup_not_saved`.
- Treats rejected storage removal like a returned storage error: clear private text, retain the audio path, make the call due for the existing purge.
- Isolates rejected per-call storage/mark operations during purge; keeps the call eligible for retry and continues with later calls.
- Preserves flag-independent retention, company filters, private storage and existing architecture.

These are error-handling fixes, **not terminal-deletion or stale-worker protection**. After the existing five processing attempts, a persistent cleanup error still fails the job; a durable cleanup mechanism is required for the stronger guarantee.

## Why database approval is necessary

The current call updates do not carry the lease. A preflight read followed by a write can race deletion or a new claimant. `samtal_claim_jobs` can claim purged calls, `samtal_mark_deleted` does not invalidate their jobs, and `samtal_release_job` checks the token but not expiry. A restored transcript keeps its deletion marker and is no longer selected by the current purge function.

An upload followed by a failed path save can also leave an object outside the call's cleanup references. Immediate compensation is insufficient when the process crashes or compensation fails. Do not introduce a best-effort workaround and claim this is solved.

## Proposed transaction contract

1. All Samtal lifecycle functions lock **call first, job second, cleanup records third**. Claims must follow that same order; never introduce call→job / job→call inversion.
2. Worker writes verify company, call identity, running job, exact token, unexpired lease, unexpired retention and nonterminal/private state inside the same transaction.
3. Starting deletion makes content terminal and invalidates queued/running/paused work before any external storage request. Retain a durable cleanup path until confirmed storage deletion; text and audio cleanup need separate completion state.
4. Claim, manual restart, upload finalization, audio-link eligibility and inbox/task materialization must use the same lifecycle rules.
5. Cleanup works with `SAMTAL` disabled. Failed storage and database operations remain discoverable after process death.
6. Preserve existing shared Inbox/customer/message/quote retention. Already materialized requests currently remain after raw-call deletion; redefining that policy needs separate approval.

## SQL draft A — terminal-content guard

The following illustrates an atomic tombstone guard for the existing call row. It is **not sufficient alone**: failed audio removal requires the cleanup ledger below, and lease-fenced writes plus transactional handoff are also necessary. Do not apply this block independently to today's private cleanup path.

```sql
CREATE FUNCTION public.samtal_guard_terminal_content()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.content_deleted_at IS NOT NULL THEN
    IF NEW.content_deleted_at IS DISTINCT FROM OLD.content_deleted_at THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'samtal_content_terminal';
    END IF;
  END IF;
  IF NEW.content_deleted_at IS NOT NULL AND
     (NEW.transcript IS NOT NULL OR NEW.extraction IS NOT NULL OR
      NEW.audio_path IS NOT NULL OR NEW.caller_phone IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'samtal_content_terminal';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.samtal_guard_terminal_content() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_guard_terminal_content() TO service_role;

CREATE TRIGGER samtal_terminal_content_guard
BEFORE INSERT OR UPDATE ON public.samtal_calls
FOR EACH ROW EXECUTE FUNCTION public.samtal_guard_terminal_content();
```

## SQL draft B — lease-fenced transcript persistence

Example of the lock/eligibility contract; production design must provide equivalent operations for every permitted content/status transition. The handler must not fall back to direct writes if this returns false.

```sql
CREATE FUNCTION public.samtal_save_transcript_guarded(
  p_company uuid, p_call uuid, p_job uuid, p_token uuid, p_transcript jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c public.samtal_calls%ROWTYPE;
  j public.samtal_jobs%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.samtal_calls
    WHERE id = p_call AND company_id = p_company FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO j FROM public.samtal_jobs
    WHERE id = p_job AND call_id = p_call AND company_id = p_company FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF c.content_deleted_at IS NOT NULL OR c.status = 'privat'
     OR c.classification = 'privat' OR c.delete_after <= clock_timestamp()
     OR j.state <> 'running' OR j.lease_token IS DISTINCT FROM p_token
     OR j.lease_until IS NULL OR j.lease_until <= clock_timestamp()
     OR p_transcript IS NULL THEN
    RETURN false;
  END IF;
  UPDATE public.samtal_calls SET transcript = p_transcript
    WHERE id = p_call AND company_id = p_company;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.samtal_save_transcript_guarded(uuid, uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_save_transcript_guarded(uuid, uuid, uuid, uuid, jsonb)
  TO service_role;
```

## SQL draft C — durable audio-cleanup ledger

Proposed new Samtal-only table, server-only, no browser policies. Grant order is intentional. No new Storage policy is proposed.

```sql
CREATE TABLE public.samtal_audio_cleanup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  call_id uuid,
  audio_path text NOT NULL CHECK (audio_path LIKE company_id::text || '/%'),
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'attached', 'pending', 'deleted')),
  retry_after timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,60}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, audio_path),
  FOREIGN KEY (company_id, call_id) REFERENCES public.samtal_calls(company_id, id)
    ON DELETE SET NULL (call_id)
);
GRANT ALL ON public.samtal_audio_cleanup TO service_role;
ALTER TABLE public.samtal_audio_cleanup ENABLE ROW LEVEL SECURITY;
-- No authenticated/anon grants or policies: only server-side cleanup can use this ledger.
CREATE INDEX samtal_audio_cleanup_due_idx ON public.samtal_audio_cleanup(retry_after)
  WHERE state IN ('reserved', 'pending');
CREATE INDEX samtal_audio_cleanup_call_idx ON public.samtal_audio_cleanup(company_id, call_id);

CREATE FUNCTION public.samtal_touch_audio_cleanup() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
REVOKE ALL ON FUNCTION public.samtal_touch_audio_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_touch_audio_cleanup() TO service_role;
CREATE TRIGGER samtal_audio_cleanup_touch BEFORE UPDATE ON public.samtal_audio_cleanup
  FOR EACH ROW EXECUTE FUNCTION public.samtal_touch_audio_cleanup();
```

This table draft is **not an implemented recovery pipeline**. Required transaction/API designs before approval:

- Reserve the exact path durably **before** upload; failed reservation means no upload.
- Attach a confirmed upload atomically to a nonterminal call, or leave it pending cleanup.
- Cancellation/purge transfers the attached path to cleanup before clearing the call path.
- Cleanup and in-flight uploads require a bounded upload lease and reconciliation; deleting an empty reserved path while an upload is still running is not completion. A late successful upload after cancellation must remain discoverable for a later deletion.
- Cleanup of pending/unattached paths must remain recoverable after a crash and a failed storage request, without requeueing transcription.
- Mark an object deleted only after confirmed Storage API success and guarded cleanup persistence. Do not delete `storage.objects` rows in SQL.
- Existing orphan discovery needs a separately approved, bounded company-scoped reconciliation design. No live object listing or audio access was performed.

## Remaining SQL/API work — approval required, not drafted as executable migrations

| Operation | Required change |
|---|---|
| `samtal_claim_jobs` | Claim only live, nonprivate calls with persisted audio; use call-first locking and recheck eligibility after locks |
| `samtal_release_job` | Verify unexpired token ownership; never revive deletion-cancelled work |
| `samtal_mark_deleted` | Atomically terminalize content, record cleanup path and invalidate jobs; preserve retry state until audio cleanup completes |
| Private cleanup | Atomically classify private and clear text before external deletion, using durable audio reference |
| Manual restart | Same atomic call eligibility; never queue deleted/private/expired calls |
| Audio links | Reject terminal/private/expired content before signing; existing signed-link lifetime remains bounded |
| Inbox/tasks | New Samtal-only transaction wrapper around unchanged `estim_receive`, with the call/job locks held through materialization; task creation in the same boundary |

Do not change shared ingestion, AI workers, delivery, Nylas, Unipile, WhatsApp, Anbud or quotes. If the transaction wrapper cannot preserve these boundaries, stop for additional approval.

## Compatibility and rollout gate

- Today's committed application patch uses only existing columns/RPCs.
- No proposed SQL is imported by app code, test setup or migration runners.
- No SQL application, generated-type change or runtime use of the new functions is authorized.
- Before eventual rollout: test the complete SQL contracts in synthetic PGlite fixtures, including real concurrent transactions; review grants/tenant isolation; approve live changes separately; coordinate any old in-flight worker handling; only then wire the Samtal adapter to the new RPCs.
- Do not claim terminal retention, durable orphan recovery or stale-worker protection until those gates pass.