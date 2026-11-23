// Presentation-only helpers: never change the store's order or message data.
export function nearConversationBottom(scrollTop: number, clientHeight: number, scrollHeight: number) {
  return scrollHeight - scrollTop - clientHeight <= 80;
}

// Distance (px) from an edge before a scroll-jump button appears.
export const SCROLL_JUMP_THRESHOLD = 240;

export function scrollToEdge(el: HTMLElement | null, edge: 'top' | 'bottom') {
  if (!el) return;
  const top = edge === 'top' ? 0 : el.scrollHeight;
  if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'smooth' });
  else el.scrollTop = top;
}

// Real threads group by the stored customer row (the same match estim_receive uses); demo records
// have no customer id and fall back to contact details, then name.
export function customerKeyOf(t: { name: string; email?: string; phone?: string; customerId?: string | undefined }): string {
  if (t.customerId) return `id:${t.customerId}`;
  const email = t.email && t.email !== '—' ? t.email.trim().toLowerCase() : '';
  const phone = t.phone && t.phone !== '—' ? t.phone.replace(/\D/g, '') : '';
  return email || phone || t.name.trim().toLowerCase();
}

export function latestActivityOrder<T extends { id: string }>(threads: T[], activity: ReadonlyMap<string, number>) {
  return [...threads].sort((a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0));
}