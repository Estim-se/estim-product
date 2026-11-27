// estim Samtal test mode: enter a phone number and paste a conversation instead of receiving it from Lynes.
// Everything after submission is the real Samtal pipeline. Shown only to allowlisted users in the test company.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { Button } from '@/components/ui/button';
import { getSamtalTestAccess, submitSamtalTestCall } from '@/lib/samtal/test-call.functions';

const RESULT: Record<string, string> = {
  done: 'Klart – samtalet är bearbetat. Se Inkorgen och granskningen nedan.',
  privat: 'Privat samtal – inget affärsunderlag skapades.',
  osaker: 'Samtalet behöver granskas.',
  retry: 'AI svarade inte – försöker igen automatiskt.',
  stopped: 'Bearbetningen stoppades.',
};

export function SamtalTestCall() {
  const access = useServerFn(getSamtalTestAccess), submit = useServerFn(submitSamtalTestCall);
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['samtal-test-access'], queryFn: () => access() });
  const [numberId, setNumberId] = useState(''), [phone, setPhone] = useState(''), [text, setText] = useState('');
  const [busy, setBusy] = useState(false), [status, setStatus] = useState<string | null>(null);
  if (!q.data?.allowed) return null;
  const selected = numberId || q.data.numbers[0]?.id || '';
  const send = async () => {
    setBusy(true); setStatus(null);
    try {
      const r = await submit({ data: { number_id: selected, customer_phone: phone, transcript: text } });
      const p = r.processed[0];
      setStatus(r.status !== 'registered' ? `Samtalet togs inte emot (${r.status}).` : p ? RESULT[p] ?? `Resultat: ${p}` : 'Samtalet väntar på bearbetning.');
      await queryClient.invalidateQueries();
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Något gick fel.'); }
    finally { setBusy(false); }
  };
  return <div className="card mt16">
    <h3>Testsamtal</h3>
    <div className="sub">Ersätter bara samtalet från telefonileverantören. Resten är den riktiga bearbetningen med riktig AI. Inget skickas till kunden.</div>
    <label className="row between mt12"><span>Anställd</span>
      <select value={selected} onChange={e => setNumberId(e.target.value)}>{q.data.numbers.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label>
    <label className="row between mt8"><span>Kundens telefonnummer</span>
      <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="070-123 45 67" /></label>
    <label className="mt8" style={{ display: 'block' }}><span>Samtalet</span>
      <textarea className="mt8" rows={10} style={{ width: '100%' }} value={text} onChange={e => setText(e.target.value)}
        placeholder={'Kund: Hej, jag vill byta tre eluttag i köket.\nDaniel: Absolut, vilken adress gäller det?'} /></label>
    <div className="row mt12" style={{ gap: 8 }}>
      <Button variant="prototype" className="btn btn-sm" disabled={busy || !selected || !text.trim()} onClick={() => void send()}>{busy ? 'Bearbetar…' : 'Skicka in samtal'}</Button>
      <Button variant="prototype" className="btn btn-sm" disabled={busy} onClick={() => { setPhone(''); setText(''); setStatus(null); }}>Rensa</Button>
    </div>
    {status && <div role="status" className="flag mt8">{status}</div>}
  </div>;
}
