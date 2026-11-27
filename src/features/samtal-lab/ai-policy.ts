// Access and budget rules for the lab's real-AI calls. Pure so they can be tested offline.

// Only these signed-in accounts may trigger real AI. Empty list = real AI disabled for everyone.
export const LAB_AI_ALLOWED_EMAILS: readonly string[] = ['moi-ali@hotmail.com', 'hassan@futureventures.se'];

// Soft budget for the demo (approved: about 15 credits). Counted per server instance.
export const LAB_AI_LIMITS = { perUserPerHour: 15, totalPerInstance: 60, maxChars: 6000 } as const;

export function isAllowedDemoUser(email: unknown, allowed: readonly string[] = LAB_AI_ALLOWED_EMAILS): boolean {
  if (typeof email !== 'string' || !email.includes('@')) return false;
  const e = email.trim().toLowerCase();
  return allowed.some(a => a.trim().toLowerCase() === e);
}

export type Budget = { total: number; perUser: Map<string, number[]> };
export const newBudget = (): Budget => ({ total: 0, perUser: new Map() });

// Reserves one call; returns a Swedish reason when the call must not run.
export function reserveCall(b: Budget, userId: string, now: number, limits = LAB_AI_LIMITS): string | null {
  if (b.total >= limits.totalPerInstance) return 'Demobudgeten för riktig AI är slut.';
  const recent = (b.perUser.get(userId) ?? []).filter(t => now - t < 3600_000);
  if (recent.length >= limits.perUserPerHour) return 'För många analyser den senaste timmen. Vänta en stund.';
  recent.push(now); b.perUser.set(userId, recent); b.total += 1;
  return null;
}
