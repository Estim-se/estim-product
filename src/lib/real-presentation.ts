import type { Thread } from '@/data/inbox';

export function companyInitials(name: string) {
  return name.trim().split(/\s+/).map(word => word[0] ?? '').slice(0, 2).join('').toUpperCase();
}

export function realSentStatus(thread: Thread): string[] {
  const sent = thread.msgs.filter(message => message.from !== 'kund' && message.from !== 'sys').at(-1);
  return [sent?.quote ? 'Offert skickad' : 'Svar skickat', 'chip-line'];
}

export function auditEvent(item: { event: string; actor_name: string; approved_name: string }) {
  return item.event === 'Svar godkänt' ? item.event : `${item.event}${item.actor_name ? ' av ' + item.actor_name : ''}`;
}

export function auditTimeline(item: { event: string; actor_name: string; approved_name: string }) {
  return item.event === 'Svar godkänt' && item.approved_name
    ? `${item.event} · Godkänd av ${item.approved_name}` : auditEvent(item);
}