# estim Samtal Priority 1 V2 – unapplied application patch

Status: prepared, **not applied**. `docs/samtal/priority-1-app-patch.diff` applies cleanly to main; it calls V2
database functions that the live database does not have, so it must only be applied together with the approved V2 schema
and regenerated types.

## Files and functions

| File | Change |
|---|---|
| `src/lib/samtal/page.server.ts` | `loadSamtalPage`: pending reviews from `samtal_reviews` (service read bounded to company + RLS-visible call ids; adds `needs_review`, hides title, private calls offer no audio). `samtalAudioLink(user, admin, callId, actorId)`: `samtal_audio_access_guarded` before signing and again before returning. `startSamtalCall(user, admin, callId, actorId)`: only `samtal_restart_guarded`, no direct job/call writes. New `reviewSamtalCall`: `samtal_confirm_review` with session company and verified actor. |
| `src/lib/samtal/samtal.functions.ts` | Passes `context.userId` to audio/start; new `confirmSamtalReviewFn({call_id, request_id, decision: business/private})`, strict schema. |
| `src/lib/samtal/labels.ts` | `privat` → "Privat – raderas" (no claim of physical deletion); `uncertain_needs_review` label. |
| `src/components/estim/samtal-page.tsx` | "Att bedöma" card ("Det är ett jobb" / "Privat – radera"); one stable request id per call and decision until success; no "Bearbeta" for reviews or private calls. |

## Tests

`src/test/samtal-app-patch.test.ts` (17) applies the patch to a disposable copy and checks authorization, tenant isolation,
concurrent review, ambiguous timeout retry, guarded audio, guarded restart and no type casts. Full Samtal run:
271 passed (254 previous + 17 new).

## Remaining dependencies

- V2 schema applied and production types regenerated (the patch does not typecheck before that).
- Two existing tests in `samtal-sida.test.ts` cover the old raw audio/restart behaviour and must be updated when the patch is applied.
- Ingest/process/Inbox/purge/routes (readiness step 2) and provider/shared-worker gates are untouched.

Next smallest step: approval to prepare the step 2 patch for the remaining Samtal modules.
