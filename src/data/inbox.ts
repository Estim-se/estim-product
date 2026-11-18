import demo from './demo.json';

export interface Message {
  from: string;
  ch?: string;
  time: string;
  text: string;
  auto?: boolean;
  quote?: boolean;
  att?: string[];
}

export interface Thread {
  id: string; name: string; ini: string; ch: string; chs: string[];
  time: string; place: string; addr: string; phone: string; email: string;
  job: string; status: string; read: boolean; autopilot: boolean; waWin: boolean;
  msgs: Message[]; asks: (string | number)[][]; facts: string[][];
  why: string; att: string[]; events: string[][];
  q: { nr: string; owners: number; addOn: boolean; prisform: string; lines: { t: string; typ: string; q: number; u: string; p: number; rot: boolean; opt?: boolean }[] } | null;
  opened?: boolean; briefSent?: boolean; week?: string; stage2?: boolean; lastSent?: string;
}
export type InboxFilter = 'alla' | 'mig' | 'ai' | 'vunna';

// Local copies allow demo interactions without changing the source records.
export function initialThreads(): Thread[] {
  return structuredClone(demo.threads);
}

export function waitingThreads(threads: Thread[]) {
  return threads.filter(t => t.status === 'svar' || (t.status === 'oppnad' && !t.autopilot));
}

export function filterThreads(threads: Thread[], filter: InboxFilter) {
  return threads.filter(t => filter === 'alla'
    || (filter === 'mig' && (t.status === 'svar' || (t.status === 'oppnad' && !t.autopilot)))
    || (filter === 'ai' && ['ai', 'analys', 'skickad', 'oppnad', 'bokat'].includes(t.status))
    || (filter === 'vunna' && t.status === 'vunnen'));
}

export function threadStatus(thread: Thread): string[] {
  if (thread.status === 'skickad' && thread.opened) return ['Öppnad', 'chip-sage'];
  return demo.statuses[thread.status as keyof typeof demo.statuses] ?? demo.statuses.ai;
}

export function channelIcon(channel: string) {
  return demo.channels[channel as keyof typeof demo.channels]?.[1] ?? 'mail';
}

export function simulatedRequest(): Thread {
  const time = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  const request = structuredClone(demo.newRequest);
  return { ...request, time, msgs: request.msgs.map(m => ({ ...m, time })), waWin: false,
    asks: [['Pris för uttag och belysning', 0]], facts: [['warn', 'Saknas: antal lampor och avstånd'], ['spark', 'Autopilot: AI ställer följdfrågor direkt']], why: '', att: [], q: null, events: [[time, 'SMS från Sofia']] };
}