# estim Samtal A1 + A2 – provider transcripts and configurable speech to text (UNAPPLIED)

Status: prepared and tested locally only. Nothing is applied to the app, the database, Storage, secrets, flags or cron.

## Files

| File | What |
|---|---|
| `docs/samtal/a1-a2-app-patch.diff` | Third application patch. Apply after `priority-1-app-patch.diff` and `priority-1-app-patch-remaining.diff`. |
| `docs/samtal/a1-provider-transcript.sql` | SQL candidate, applied after `priority-1-coordinated-v2.sql`. |
| `src/test/samtal-a1-a2.test.ts` | 19 synthetic tests (all three patches applied to a disposable copy, local PostgreSQL 17). |

## Patch contents

- **`provider-transcript.ts` (new):** strict validation of a provider transcript.
  - It must be complete (`complete: true`), with ordered, bounded segments inside the call duration and non-empty text.
  - It must carry the same provider and provider call id as the adapter's call.
  - Company, employee or any unknown field is rejected.
  - Output: the standard `Transcript` with speakers, times, language and `provenance: {kind:'provider', provider, provider_call_id}`.
- **`transcript.ts`:** optional `provenance` on `Transcript`. Absent means speech to text.
- **`call.ts`:** `audio` is optional and `transcript` is new and optional, but at least one is required.
- **`ingest.server.ts`:**
  - **Audio only:** unchanged V2 flow.
  - **Transcript only:** the transcript is validated, then `samtal_ingest_transcript` runs. There is no audio reservation and no upload.
  - **Both:** the V2 audio flow runs, then the validated transcript is attached. An invalid transcript is ignored, so speech to text is used instead.
  - **Neither valid:** returns `failed` with a structural code and stores nothing.
- **`process.server.ts`:**
  - A transcript call starts at `tolka`, so speech to text is skipped.
  - `stt_unsupported_provider` waits hourly like a missing key.
  - Calls with no content still fail safely.
- **`stt-config.server.ts` (new):** `selectSpeechToText()` reads `SAMTAL_STT_PROVIDER`.
  - Default is `berget`, and `none` turns speech to text off.
  - Unknown values give the code `stt_unsupported_provider`.
  - Resolution is lazy: a key is read only when audio really has to be transcribed.
  - New services are added through the registry, with no change to the pipeline.
- **`samtal-worker.ts`:** uses `selectSpeechToText()` instead of `bergetSpeechToText()`.
- **`test-adapter.server.ts`:** a guard for calls that have no audio.

## SQL candidate

- **`samtal_ingest_transcript(payload, p_transcript)`, service role only:**
  - Same registration as `samtal_ingest_recover`: receiving number to company, tenant lock, replay denials, backpressure, duplicate key.
  - It checks the provenance again.
  - It refuses deleted, private, erased, expired or retired calls, and calls in another tenant.
  - It attaches the transcript only when the call has none yet and the job is at `transkribera` and not running. The job then moves to `tolka`.
- **`samtal_claim_jobs`:** the V2 claim, with one condition widened. A call can now be claimed with a recording **or** a stored provider transcript.

There are no table, column, policy or grant changes.

## Preserved V2 guarantees

The 19 new tests confirm that these still hold:
- **Tombstones:** a purged call is never recreated.
- **Lease fencing:** an expired lease stops the worker without writing.
- **Idempotency:** concurrent and duplicate events create one call and one job.
- **Tenant isolation:** company comes from the number only, and a malicious transcript has no effect on it.
- **Private deletion without audio:** text is removed at once and nothing is created.
- **Fair claim:** the claiming logic is unchanged.
- **Human approval:** drafts always have `needs_review = true`, and nothing is sent.

## Mocked versus verified

Mocked:
- The telephony adapter.
- Speech to text. Berget is never called: its key is absent and `fetch` is spied on.
- AI classification, which is deterministic.
- Storage, which is an in-memory fake.

**Not verified:** any real provider, Lynes transcript quality or format, Berget, real AI accuracy, and the shared AI worker.

## Limitations

- **Manual restart and listening need a recording.** `samtal_restart_guarded` and audio access still require one, so a transcript-only call cannot be restarted manually and has nothing to play. This is the V2 behaviour, unchanged.
- **Lynes format unknown.** The transcript field names in `providerTranscriptInputSchema` are provider-neutral. A real Lynes adapter must map Lynes' format to them.
- **Wait time for misconfiguration.** A misconfigured speech-to-text service waits hourly but has no alert yet (A6).
- **Types not regenerated.** Database types are not regenerated, because the patch depends on the V2 and A1 SQL being installed. The full TypeScript check covers the repository, not the patched copy.
