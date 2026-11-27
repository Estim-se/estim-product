/**
 * supabase-js re-emits SIGNED_IN for the already signed-in user whenever the tab regains focus (session recovery).
 * Only a SIGNED_IN for a different (or first) user is a real sign-in that needs a fresh workspace and caches.
 */
export function isSessionRecovery(event: string, eventUserId: string | undefined, loadedUserId: string | null) {
  return event === 'SIGNED_IN' && Boolean(eventUserId) && eventUserId === loadedUserId;
}
