// estim Samtal in Inkorg: calls awaiting confirmation are listed as ordinary Inbox items (phone icon, "Samtal"),
// and the selected call shows its summary, transcript, tasks and the existing A9/A10 confirmation in the
// conversation column. An uncertain call is never attached to a customer here; it stays its own item until confirmed.
import { useQuery } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import type { Thread } from '@/data/inbox';
import { getSamtalA10Review, type CallTask } from '@/lib/samtal/a10/review.functions';
import { TASK_KIND, TASK_STATE } from '@/lib/samtal/labels';
import { useWorkspace } from './workspace-provider';
import { SamtalA10ReviewPanel } from './samtal-a10-review';

export const SAMTAL_ITEM = 'samtal:';
type ReviewCall = { call: string; state: string; title: string; summary?: string; transcript?: { speaker: string | null; text: string }[];
  thread_id?: string | null; started_at?: string | null; tasks?: CallTask[]; heard?: { name: string | null; phone: string | null; caller: string | null; address: string | null } };

export function useSamtalCalls() {
  const workspace = useWorkspace(), load = useServerFn(getSamtalA10Review), company = workspace.data?.company;
  const q = useQuery({ queryKey: ['samtal-a10', company?.id], queryFn: () => load(), enabled: workspace.mode === 'real' && !!company, staleTime: 15000 });
  return (q.data?.enabled ? q.data.calls : []) as ReviewCall[];
}

const time = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'short' }) : '';
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';

// Unconfirmed calls as Inbox list items; the shape is the existing Thread so the existing list card renders them.
export function pendingCallThreads(calls: ReviewCall[]): Thread[] {
  return calls.filter(c => c.state === 'pending' || c.state === 'new').map(c => {
    const name = c.heard?.name || c.heard?.phone || c.heard?.caller || 'Okänd uppringare';
    return { id: SAMTAL_ITEM + c.call, customerId: SAMTAL_ITEM + c.call, name, ini: initials(name), ch: 'samtal', chs: ['samtal'], time: time(c.started_at), place: '', addr: c.heard?.address ?? '—',
      phone: c.heard?.phone ?? c.heard?.caller ?? '—', email: '—', job: c.title, status: 'svar', read: false, autopilot: false, waWin: false,
      msgs: [{ from: 'kund', ch: 'samtal', time: time(c.started_at), text: `Bekräfta kund: ${c.summary || c.title}` }], asks: [], facts: [], why: '', att: [], events: [], q: null } as unknown as Thread;
  });
}

function due(t: CallTask) {
  if (t.due_at) return time(t.due_at);
  if (!t.due_date) return '';
  const day = new Date(`${t.due_date}T12:00:00Z`).toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'short' });
  return t.due_hint ? `${day} ${t.due_hint}` : day;
}

function CallBody({ c }: { c: ReviewCall }) {
  return <>
    <div className="small"><b>Sammanfattning:</b> {c.summary || c.title}</div>
    {!!c.tasks?.length && <div className="small"><b>Uppgifter och påminnelser</b><ul className="mt8">{c.tasks.map(t =>
      <li key={t.id}>{TASK_KIND[t.kind] ?? t.kind}: {t.title}{due(t) ? ` · ${due(t)}` : ''}{t.address ? ` · ${t.address}` : ''} <span className="xs muted">({TASK_STATE[t.state] ?? t.state})</span></li>)}</ul></div>}
    {!!c.transcript?.length && <details className="small"><summary>Visa samtalet</summary><div className="mt8 space-y-1">{c.transcript.map((l, i) =>
      <p key={i}>{l.speaker && <b>{l.speaker}: </b>}{l.text}</p>)}</div></details>}
  </>;
}

// The selected unconfirmed call, shown in the conversation column.
export function SamtalCallPane({ id, onDone }: { id: string; onDone: (threadId: string | null) => void }) {
  const call = useSamtalCalls().find(c => SAMTAL_ITEM + c.call === id);
  if (!call) return <div className="card m16 small muted">Samtalet är redan hanterat.</div>;
  return <div className="card m16 space-y-3 min-w-0" aria-label="Samtal att bekräfta"><CallBody c={call} /><SamtalA10ReviewPanel only={call.call} onDone={onDone} /></div>;
}

// A confirmed call inside its ordinary conversation: summary, tasks and the original transcript.
export function SamtalCallDetails({ threadId }: { threadId: string }) {
  const calls = useSamtalCalls().filter(c => c.thread_id === threadId);
  if (!calls.length) return null;
  return <div className="space-y-3 min-w-0 p16" aria-label="Samtal">{calls.map(c => <div key={c.call} className="space-y-2"><CallBody c={c} /><SamtalA10ReviewPanel only={c.call} /></div>)}</div>;
}
