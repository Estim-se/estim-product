# estim Samtal Priority 1 V2 – historical application patch

Status: historical proposal. The current application source has since evolved, and
`docs/samtal/priority-1-app-patch.diff` is not an executable patch for current main. Do not apply it as-is. The current
test validates the present modules instead of applying this historical diff. Verify database deployment separately;
this document is not evidence that any schema is deployed.

## Files and functions

| File | Change |
|---|---|
| `src/lib/samtal/page.server.ts` | `loadSamtalPage`: pending reviews from `samtal_reviews` (service read bounded to company + RLS-visible call ids; adds `needs_review`, hides title, private calls offer no audio). `samtalAudioLink(user, admin, callId, actorId)`: `samtal_audio_access_guarded` before signing and again before returning. `startSamtalCall(user, admin, callId, actorId)`: only `samtal_restart_guarded`, no direct job/call writes. New `reviewSamtalCall`: `samtal_confirm_review` with session company and verified actor. |
| `src/lib/samtal/samtal.functions.ts` | Passes `context.userId` to audio/start; new `confirmSamtalReviewFn({call_id, request_id, decision: business/private})`, strict schema. |
| `src/lib/samtal/labels.ts` | `privat` → "Privat – raderas" (no claim of physical deletion); `uncertain_needs_review` label. |
| `src/components/estim/samtal-page.tsx` | "Att bedöma" card ("Det är ett jobb" / "Privat – radera"); one stable request id per call and decision until success; no "Bearbeta" for reviews or private calls. |

## Tests

`src/test/samtal-app-patch.test.ts` checks the current source for authorization, tenant isolation, concurrent review,
ambiguous timeout retry, guarded audio and guarded restart. This is not current validation evidence.

## Historical proposal dependencies

- The proposal depended on V2 SQL and regenerated types at the time; verify the current database state independently.
- The page tests have since been updated to the current call shape.
- Ingest/process/Inbox/purge/routes (readiness step 2) and provider/shared-worker gates are untouched.

Retain this file and its diff for historical context, not as an implementation checklist.
