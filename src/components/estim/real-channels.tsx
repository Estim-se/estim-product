import { useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { saveWhatsAppChannel } from '@/lib/channel.functions';
import { receiveMessageUrl } from '@/lib/channel-rules';
import { Button } from '@/components/ui/button';
import { TopHeader } from './top-header';
import { useWorkspace } from './workspace-provider';

export function RealChannels() {
  const workspace = useWorkspace();
  const [number, setNumber] = useState(workspace.data?.channels?.find(c => c.type === 'wa')?.phone_number_id ?? '');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const save = useServerFn(saveWhatsAppChannel);
  return <><TopHeader title="Kanaler" subtitle="WhatsApp" /><section className="mt24">
    <h2>WhatsApp via n8n</h2>
    <label className="field mt16">Adress för inkommande meddelanden<input className="input" readOnly value={receiveMessageUrl} /></label>
    <form className="mt16" onSubmit={async e => { e.preventDefault(); setBusy(true); setMessage('');
      try { await save({ data: { phone_number_id: number } }); await workspace.refresh(); setMessage('WhatsApp-numret är sparat.'); }
      catch (error) { setMessage(error instanceof Error ? error.message : 'Kunde inte spara WhatsApp-numret.'); } finally { setBusy(false); } }}>
      <label className="field">WhatsApp phone_number_id<input className="input" inputMode="numeric" pattern="[0-9]{1,100}" required maxLength={100} value={number} onChange={e => setNumber(e.target.value)} /></label>
      <Button variant="prototype" className="btn btn-primary mt12" type="submit" disabled={busy}>{busy ? 'Sparar…' : 'Spara'}</Button>
    </form>{message && <p className="mt12" role="status">{message}</p>}
    <p className="mt16 muted">WhatsApp-utskick är inte kopplat än</p>
  </section><section className="mt24"><h2>Inkommande e-post</h2><p className="mt8">{workspace.data?.company?.inbound_address}</p><span className="chip chip-line mt12">Inte ansluten</span></section></>;
}