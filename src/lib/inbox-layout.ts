// Presentation-only helpers: never change the store's order or message data.
export function nearConversationBottom(scrollTop: number, clientHeight: number, scrollHeight: number) {
  return scrollHeight - scrollTop - clientHeight <= 80;
}

export function latestActivityOrder<T extends { id: string }>(threads: T[], activity: ReadonlyMap<string, number>) {
  return [...threads].sort((a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0));
}